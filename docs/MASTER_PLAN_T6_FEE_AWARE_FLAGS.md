# T6 — Fee-aware flag trades, state model, failed-flag reversals

Last updated: 2026-09-24
Status: plan, approved by owner for implementation in a separate thread. Phase order is fixed; one phase is merged and deployed before the next starts.
Branch: `upgrade-signal-engine`. Tracker repo: `../edittrades-tracker`.
Inputs:
- this thread's findings (T4 `docs/PLAN_FLAG_PATHS.md`, `docs/FLAG_PATHS_BASE_RATES.md`, `docs/BREAKOUT_ENTRY_SHADOW.md`; T5 `docs/PLAN_DIVERGENCE_OPPORTUNITIES.md`, `docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`)
- the owner's workflow review `EditTrades_Opportunity_Workflow_Refinement.docx` (summarised below)

## 1. Problems

### 1a. Fees make "ready" trades unwinnable (highest priority)

Live evidence, from the tracker's only ready-plan fill in 7 days:

| | Value |
| --- | --- |
| Trade | BTC 1m short, 2026-09-24 11:57Z |
| entry / stop / tp1 | 83,409.4 / 83,464.3 / 83,228 |
| Stop distance | **0.066%** |
| grossRR / netRR | 3.30 / **0.07** |
| Result | stop: −1R gross, **−4.0R net** |

The engine knew the trade was net 0.07 but called it ready, because the gate is gross R:R only (owner decision 1a). Replays say the same: on 1m–5m flags the retest entry is −0.32R net per trade, the breakout-close entry −0.65R, the early entry −0.65R (T4 P4, T5 P0).

The fee math. With round-trip cost `c` (config: 2 × (5 fee + 5 slippage bps) = **0.20%** of entry), stop distance `s` (% of entry) and gross target `G × s`:
- cost in R = `c / s`
- netRR = `(G·s − c) / (s + c)`
- minimum stop for a required net `N` at gross `G`: `s_min = c·(1 + N) / (G − N)`

| Required net (at gross 3) | Min stop at c = 0.20% | Min stop at c = 0.14% |
| --- | --- | --- |
| netRR ≥ 1.5 | 0.33% | 0.23% |
| netRR ≥ 2.0 | **0.60%** | 0.42% |
| netRR ≥ 2.5 | 1.40% | 0.98% |

- Position size and leverage do **not** change fees in R: both scale with notional. "Bigger bags" don't help. Only a wider structural stop with a proportionally wider target, or a lower cost per trade, help.
- Most 1m flags have stops of 0.05–0.3%, so as scalps they are un-tradeable at this cost. They are still good **triggers**.

### 1b. Flags should also serve longer plays

A 1m–5m flag is a good entry *trigger*. For the trade to survive fees, its risk and target can come from higher-timeframe (5m/15m/1h) structure: a "trigger on the lower timeframe, risk on the higher timeframe" swing variant.

### 1c. Workflow gaps (owner docx)

- **State clarity:** keep four layers separate at all times: CONTEXT → PATTERN → TRIGGER → TRADE. A confirmed pattern is not an approved trade, and a failed long is not an automatic short.
- **Missing bridge:** a failed tracked flag should open a structured opposite-side **FAILED_FLAG_REVERSAL** scout (failed reclaim of the broken level, then its own room / R:R / net gates), not just "long damaged".
- **Live protocol:**
  - persistent tracking of one setup (one trigger, one thesis-null, a finite window)
  - updates answer STATUS / FORMING / DELTA / TRIGGER-NULL / REVERSAL SCOUT / NEXT CHECK
  - WARNING (lower-timeframe damage) vs NULL (execution-timeframe invalidation)
  - every level tagged with its timeframe
  - MISSED / NO CHASE state
  - auto-expire stale triggers
  - reset the tracker when the user's direction changes

### 1d. Carried over

- 60-day history (S2) is capturing in `test/fixtures/history/deep60-2026-09-24/` (resumable; see `scripts/replay.js`). Re-run the T4/T5 measurements on it and rebuild the `pathOutlook` table.
- T5: no early-entry OPPORTUNITY tier (net-negative). The one net-positive combo (divergence agrees, not at a level, with the trend, retest entry, n=149) must be re-checked on 60 days.
- Owner wants to see divergence setups before the mentor. Ship them as **watch-only alerts** (no entry).

## 2. Constraints (hard; see also CLAUDE.md)

- **Serverless and MCP:**
  - No new `api/` file (12/12 Vercel functions).
  - MCP stays one read-only tool; `services/editTradesMcp.js` and `lib/mcpHttp.js` import only `services/scalpContext.js`.
- **Risk rules:**
  - Never lower `flagPlan.minRR` (gross 3).
  - Scalp stops stay ≤ 3% from entry (`scalp.maxStopDistancePct`); a swing variant also respects 3%.
  - The net gate is **added**, never replacing the gross gate.
- **Security and data:**
  - No new dependencies.
  - Never log or return keys, RPC URLs or wallet addresses.
  - Wallet status never changes `dataStatus`.
- **Deploy and repo:**
  - Deploy per CLAUDE.md: all `test:*` suites + `npm run check:gpt`, `git diff --check`, commit, push, `npx vercel --prod --yes`, then "Verify after any redeploy" in `docs/EDITTRADES_MCP_CONNECTOR.md`, `npm run tracker:sync`, push the tracker repo, `gh workflow run track -R Bai-ee/edittrades-tracker`.
  - `.vercelignore` must keep excluding `test/fixtures/history/`.
  - `public/index.html` untouched.
- **GPT instructions:** 7,984 / 7,990 units. Every new GPT behaviour must be funded by moving logic into engine-written fields (the GPT prints them) and cutting rules those fields make redundant.
- **Testing window:** Phase 1 changes a gate, so the tracker testing window restarts. Set the tracker's phase start to the Phase 1 deploy time and say so on the page.

## 3. Owner decisions (defaults; proceed on these unless the owner overrides)

| # | Decision | Default |
| --- | --- | --- |
| D1 | True round-trip cost | The code has no venue fee constants (checked 2026-09-24); the engine uses only `config/engine.json` `risk` (5 fee + 5 slippage bps per side = 0.20% round trip). Ask the owner for the venue's actual open/close fee and typical slippage; keep 0.20% (conservative) until answered. Phase 0 reports results at both 0.20% and 0.14%. |
| D2 | Net gate | `flagPlan.minNetRR` = value chosen in Phase 0 (expected 2.0, i.e. ≈ 0.6% min stop at 0.20% cost). Supersedes owner decision 1a (gross-only); record in `docs/OWNER_DECISIONS_2026-09-23.md` or a new decisions doc. |
| D3 | Swing variant | Yes, if Phase 0 shows it is net-positive. |
| D4 | Reversal scout | Scout-only (never GO IN) until Phase 0/4 replay shows it is net-positive. |
| D5 | Divergence setups | Watch-only alerts, no entry. |

## 4. Phases

### Phase 0 — Measure fee-aware stop/target rules (replay only; no live change)

`scripts/replay-stops.js` (`npm run replay:stops`) uses the labelled rows plus history (`scripts/replay-paths.js` output, `test/fixtures/history/deep-2026-09-24/`, and deep60 when complete). Simulate each variant on the same flags: fill at the retest-hold (as `flagTradePlan`), 24 h walk on 1m, gross and **net** R (`netRiskReward` / `scripts/tracker/costs.js`).

| Variant | Stop | Target |
| --- | --- | --- |
| V0 current | flag invalidation | TP1 capped at nearest level |
| V1 net gate | as V0, but skip trades with netRR < N (N ∈ 1.5, 2, 2.5) | as V0 |
| V2 structure stop | beyond the nearest 5m / 15m swing or zone on the stop side (+ buffer) | next 15m / 1h level or measured move of that structure, needs gross ≥ 3 |
| V3 ATR floor | max(invalidation distance, k × ATR of 15m) (k ∈ 0.5, 1) | 3 × stop |
| V4 failed-flag reversal | FAILED_FLAG_REVERSAL: broken level fails to reclaim within N candles (N ∈ 1–3); stop beyond the reclaim extreme | next opposing zone |

Report n, trades/day, win rate, gross / net expectancy, max losing streak, by timeframe and symbol, and per variant parameter. Choose the rule that maximises net expectancy with at least 1 trade/day across the 3 symbols; if none is net-positive, say so.

Deliverable: `docs/FEE_AWARE_STOPS_RESULTS.md` with the chosen `minNetRR`, the stop-anchoring rule, the swing-variant verdict and the reversal verdict. Also D1's cost finding.

Gate: tests pass; nothing under `api/`, `lib/`, `services/` or `config/` changes.

### Phase 1 — Fee-aware trade plans (engine; deploy)

- `lib/flagTradePlan.js`:
  - Publish `costR` (round-trip cost in R).
  - Add the net gate: new `reasonCode` values `net_rr_below_min` and `stop_inside_costs` (cost ≥ 0.5R).
  - Add `horizon: 'scalp' | 'swing'`. If the scalp variant fails the net gate or room, attempt the Phase 0-chosen swing variant (higher-timeframe structure stop and target). `ready` only if gross ≥ 3, net ≥ `minNetRR`, stop ≤ 3%, and room passes.
  - Keep the entry trigger on the flag's own timeframe; tag every level with its timeframe.
- `config/engine.json`: `flagPlan.minNetRR`, swing-variant parameters, cost values per D1. Bump configVersion and schemaVersion (additive fields).
- `lib/flagRecommendation.js`: GOOD still requires a ready plan. Add support/oppose tokens `net_rr_ok` / `fees_heavy`. No other class change.
- Replay parity: the Phase 0 script reproduces the new plan on replay.
- Tracker: restart the phase (testing window) at deploy; net-first display (net already exists); split ready plans by `horizon`.
- Tests: plan gate cases (the BTC 0.066% short → rejected `stop_inside_costs`; a swing variant that passes), fixtures updated, payload byte caps (raise minimally if needed, ≤ 80,500 B, with a comment).
- Docs: CHANGELOG, connector schema map, openapi, decisions doc.

### Phase 2 — State model, tracking, reversal scouts (engine + tracker; deploy)

**New engine output**, compact and engine-written so the GPT prints it rather than reasoning it out:

- `symbols.<SYM>.state = {context, setup, trigger, trade, label}`:
  - `context`: with/counter-trend vs 4h; room open / blocked to the nearest 15m/1h zone, with timeframe-tagged levels
  - `setup`: leading candidate id, timeframe, direction, pattern state
  - `trigger`: exactly ONE condition string, timeframe-tagged
  - `trade`: GO IN / HOLD-WAIT / DON'T, with plan `reasonCode`
  - `label`: TRACKING | WARNING | FAILED | REVERSAL_SCOUT | REVERSAL_TRIGGERING | READY | MISSED | EXPIRED
- `lib/reversalScout.js` builds `symbols.<SYM>.reversalScouts[]` from candidates that failed within `failedTtlCandles` (`failReason` acceptance / invalidation_close; the detector already keeps failed candidates visible), with the docx fields:
  - `sourceCandidateId`, `failureReason`, `direction` (opposite), `state` (scouting / triggering / confirmed / rejected / expired)
  - `brokenLevel`, `reclaimWindow`, `entryCondition`, `invalidation`
  - `nearestTarget` (a real zone, never an EMA)
  - `grossRR`, `netRR`, `reasonCode`
  - Scout-only per D4.
- **MISSED:** price reached the next zone without a valid trigger. The label says NO CHASE.
- **Tracking without state storage:** REST `GET /api/scalp-context?track=<candidateId>` (parsed after auth, like `chart`) adds `tracked = {id, status: alive | weakening | confirmed | failed | expired, delta (what changed over the last N closed execution-timeframe candles, one line), trigger, thesisNull, reversalScout, nextCheck, expiresAt}`. The GPT keeps the candidate id from the previous reply.
- A direction change by the user resets the tracked id (GPT rule, Phase 3).

**Tracker:**
- Score reversal scouts as their own class: realised path, and net R on the scout's own levels.
- Watch-only divergence alerts in `scripts/tracker/alerts.js`: fresh divergence agreeing with a forming flag near a support/resistance zone. Text names the setup, trigger and thesis-null, and never gives an entry.

**Tests:**
- state labels on the docx BTC sequence: rejected breakout 84,866.5 → WARNING → FAILED on acceptance below → REVERSAL_SCOUT → MISSED once price is in the 83.93k support
- reversal scout gates
- `track` param: 401 / 405 unchanged, unknown id → `tracked: null`
- byte caps

### Phase 3 — GPT instructions rewrite (docs only; owner pastes into a new GPT)

Rewrite `docs/GPT_INSTRUCTIONS.md` around the four layers. The GPT prints `state`, `tracked`, `pathOutlook` SCENARIO and `reversalScouts` verbatim.

**Formats:**
- Default update: STATUS / FORMING / DELTA / TRIGGER / THESIS NULL / REVERSAL SCOUT / NEXT CHECK
- TRACK mode and REVERSAL TRACK mode, per the docx
- MISSED / NO CHASE
- WARNING vs NULL
- Timeframe-tag every level
- Reset on direction change
- Never invent percentages

**Budget:**
- Fund it by deleting rules the engine now answers (e.g. derived room / trend prose, candidate-state explanations) until `npm run check:gpt` is OK.
- Test sheet: add the docx BTC scenarios, a fees-rejected plan (`stop_inside_costs`), a swing-horizon ready plan, and a MISSED case.

### Phase 4 — 60-day recalibration and review (analysis + config; deploy if tables change)

- When `deep60-2026-09-24/manifest.json` exists: re-run `replay-paths`, `replay-early-entry`, `replay-breakout-entry` and `replay-stops` on 60 days.
- `npm run paths:table` rebuild. Bump configVersion only if the tables change.
- Update the base-rate docs.
- Re-check the T5 positive combo and the reversal-scout verdict.
- Report whether any watch / scout item has earned promotion (net-positive, n ≥ 100). Promotion itself is an owner decision.

## 5. Definition of done

- A plan whose fees exceed its edge is never `ready` again, which the BTC 0.066% case proves.
- Flags can yield swing-horizon plans that pass gross 3R and the net gate.
- Every symbol carries the four-layer `state`, with a single trigger and timeframe-tagged levels.
- Failed flags produce reversal scouts, and MISSED is explicit.
- `?track=` works.
- The new GPT prints all of it within budget.
- The tracker shows net-first stats, the restarted window, horizon split, reversal scouts, calibration and watch-only divergence alerts.
- Every phase deployed and verified; docs updated.
