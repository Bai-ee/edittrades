# Review packet — 2026-09-23/24 work on `upgrade-signal-engine`

Purpose: give an independent reviewer everything needed to review and approve (or reject) the work done in two Claude Code threads:
- **Thread A:** the session that wrote this file. Covers T3, T4 P0–P4, T5 P0 + S1/S2, two production bug fixes, and the T6 plan.
- **Thread B:** a separate, ongoing Sonnet thread executing T6 Phase 0.

A few commits came from other sessions; they are listed so the reviewer can separate them.

Repo: `/Users/bballi/Documents/Repos/snapshot_tradingview`, branch `upgrade-signal-engine`. Tracker repo: `../edittrades-tracker` (GitHub `Bai-ee/edittrades-tracker`).
Range reviewed: `777ad8a..HEAD` (engine repo), 60 files, +9,852 / −290 lines, plus Thread B's uncommitted working tree (section 7).

---

## 0. Reviewer instructions (paste this section to the reviewing agent)

You are reviewing work by two coding agents on a trading-signal engine that serves a ChatGPT Custom GPT (REST Action) and an MCP connector, plus a GitHub-Actions "call tracker" that scores the engine's calls.

Read, in order:
1. `CLAUDE.md` (hard rules)
2. this file
3. each plan doc cited below
4. the diffs (`git log -p 777ad8a..HEAD`, and `git diff` for Thread B's uncommitted work)

For each workstream decide **APPROVE / APPROVE WITH CHANGES / REJECT** and give reasons. Check specifically:

1. **Hard rules held:**
   - no new `api/` file (Vercel Hobby 12/12)
   - MCP still one read-only tool; `services/editTradesMcp.js` and `lib/mcpHttp.js` import only `services/scalpContext.js`
   - scalp stop cap ≤ 3% unchanged; gross `flagPlan.minRR` 3 unchanged
   - no secrets logged or stored; account/wallet data never written to public Blob or the tracker
   - `public/index.html` untouched
2. **Nothing that drives a trade changed unintentionally.** `flagTradePlan`, `flagRecommendation` classes, strategies and `bestSignal` are unchanged except where a plan explicitly says so (none so far; the net gate is shipped **off**).
3. **Correctness of the measurement code:**
   - path labeller (`scripts/tracker/flag-paths.js`)
   - replay scripts
   - no lookahead
   - fee math (`scripts/tracker/costs.js`, `lib/flagTradePlan.js` `netRiskReward`)
4. **Claims in the result docs are supported by the data and honestly caveated** (single 15-day bull regime; correlated samples).
5. **Tests are meaningful, not tautological.** Behaviour-identical refactors really are identical.
6. **Decisions the agents made on the owner's behalf** (section 9). Were they reasonable?
7. **The T6 plan** (`docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`) is sound, correctly ordered, and consistent with the evidence.

Output: a verdict per section, a list of defects (file:line, severity, fix), and anything to roll back.

---

## 1. System context (one paragraph)

`GET /api/scalp-context` (bearer auth) returns closed-candle context for BTC/SOL/ETH built by `services/scalpContext.js`:
- 1m/3m/5m flag detection (`lib/patternDetector.js`)
- one engine trade plan per symbol (`flagTradePlan`: ready / conditional / rejected, gated on gross R:R ≥ 3 and a ≤ 3% stop)
- a GOOD/WATCH/BAD/DATA_UNAVAILABLE recommendation (GOOD ⇔ ready plan)

`POST /api/mcp` exposes the same builder as one read-only tool. `/api/journal` stores the owner's trade notes in public Vercel Blob. The tracker repo runs `scripts/tracker/*.js` (synced from this repo by `npm run tracker:sync`) every 10 minutes: it collects calls, scores them on stored 1m candles, and publishes a static page. Round-trip cost in the engine is 0.20% of price (config `risk`: 5 bps fee + 5 bps slippage per side).

## 2. Timeline of commits (engine repo)

| Commit | Time (local) | Thread | What |
| --- | --- | --- | --- |
| `e2c7a12` | 09-23 22:19 | A | T3 served calls: record every REST-served call to Blob; tracker scores them |
| `656550b` | 09-23 22:51 | other session | skip recording the tracker's own cron GET (`X-EditTrades-Client: tracker`) |
| `895f805`, `089ffcc`, `45f4d00`, `d4491d5` | 09-24 00:30–00:46 | other session | tracker: mobile style, keeper workflow, 10-min captures, GOOD email alerts, test alert |
| `cc9515c` | 09-24 02:32 | A | T4 P0 flag-path measurement (labeller, replay, 60-day-capable backfill, tracker paths step) |
| `7db1ac0` | 09-24 02:35 | A | `.vercelignore`: exclude `test/fixtures/history/`, `paper-ledger/` (deploy exceeded 100 MB) |
| `40ec985` | 09-24 02:39 | A | **Bug fix:** weak ETag → strong ETag in Blob appends |
| `980f08d` | 09-24 08:09 | A | T4 P1+P2: `pathOutlook` in payload (schema 1.19.0) + GPT SCENARIO block |
| `0e9018f` | 09-24 08:46 | A | T4 P3+P4: calibration tracking; shadow `breakoutEntry` (schema 1.20.0) |
| `343c699` | 09-24 09:12 | other session | chart snapshot in GOOD-alert emails |
| `c3e6f9f` | 09-24 09:44 | A | T5 P0 divergence / early-entry measurement; S1 net R on tracker; S2 backfill checkpoint format |
| `f0e3014`, `9b6f6aa`, `651be0a` | 09-24 10:01–10:25 | A | T6 master plan; merge of `PLAN_GOOD_QUALITY.md`; Jupiter fee reference |

Tracker repo syncs (Thread A): `cd63640` (T3), `ec52cf7` (T4 P0), `011e1d7` (T4 P3/P4), `39ec8da` (S1/T5). All other `track: …` commits are automated runs.

Production deploys (Thread A), each verified 401 / 401 / 405 / 200 plus MCP `tools/list` = one tool: after `e2c7a12`, after the other session's commits, `cc9515c`+`7db1ac0`, `40ec985`, `980f08d`, `0e9018f`. **Live now:** schema **1.20.0**, configVersion **2026.09.24-1**. `c3e6f9f` and later changed no request-path code and were not deployed.

## 3. T3 — Served calls (`docs/PLAN_SERVED_CALLS.md`)

**Goal:** every call served to the GPT via REST is recorded and scored like a cron capture (`source: 'served'`).

**What changed:**
- `lib/blobJsonl.js` (journal Blob helpers moved out of `api/journal.js`, behaviour-identical)
- `scripts/tracker/records.js` (row builder moved out of `collect.js`, re-exported)
- `lib/servedCalls.js` (recorder: 1500 ms cap, never throws, kill switch `TRACK_SERVED_CALLS=false`, off without `BLOB_READ_WRITE_TOKEN`)
- hook in `api/scalp-context.js` on the JSON 200 path only, using the **unfiltered** payload
- tracker `pullServed`, `source` dimension, "Seen in chat" activity row, "Via" column

**Safety:**
- Rows use the tracker's explicit field list + sensitive-key strip + fail-closed re-check.
- Extra credential guard `findSecretLike`: bearer/secret/api-key keys, `Bearer ` values, URLs with key parameters.
- Verified on a live payload: no false positives.
- Tests: `test:served` (18 → 20), `test:journal` 17, `test:tracker`.

**Reviewer notes:**
- The journal isolation test was edited to allow `lib/blobJsonl.js`.
- `test-scalp-context.js` sets `TRACK_SERVED_CALLS=false` so fixture payloads can never be written to real Blob.

## 4. Production bug fixes (Thread A)

1. **Blob appends silently failing (`40ec985`).**
   - Symptom: only the first write each day succeeded. Served calls stopped after 3 rows; journal appends could 503.
   - Cause: `@vercel/blob` `get()` returns a weak ETag (`W/"…"`); `put({ifMatch})` only matches the strong form. Every later append hit "Precondition failed: ETag mismatch", retried 3×, and was swallowed.
   - Fix: `strongEtag()` in `lib/blobJsonl.js` `readBlob`.
   - Verified: local real-Blob append 3 rows / 301 ms; production went from 3 → 9 rows after deploy; regression test in `test-served.js`.
   - Impact: served calls between about 03:22Z and the fix (including the owner's 04:51–05:01Z chat calls) were never recorded. Journal records may have 503'd (2 stored that day).
2. **Deploy upload over 100 MB (`7db1ac0`).** 213 MB of gitignored replay history was uploaded because `.vercelignore` didn't list it.
3. **Labeller bug (fixed before commit `cc9515c`).** A retest was searched from the breakout candle's *open*, so the breakout candle's own 1m candles always counted as a retest and runners were almost never labelled (0.3%). Fixed so a retest counts only after the breakout candle closes; regression test on the SOL case; four fixtures corrected.

## 5. T4 — Flag paths (`docs/PLAN_FLAG_PATHS.md`)

**P0, measure:**
- `scripts/tracker/flag-paths.js` (pure labeller): each flag from its tightening point → `retest_go | runner | false_break | fail_first | chop`; bucketed features; base rates.
- `scripts/replay-paths.js`: production pipeline per close, no lookahead.
- `scripts/replay.js`: resumable Kraken-trades 1m backfill, with 5m/15m (later 1h) derived from 1m for depth; OHLC wins on overlap; overlap checks in the manifest.
- Tracker `paths.js` → `data/paths.jsonl` + `#flag-paths-section`.
- `lib/flagTradePlan.js`: `export` added to `observeRetestHold` (for a parity test).

**P0 results** (`docs/FLAG_PATHS_BASE_RATES.md`; 10,997 flags, 2026-09-09 → 09-24, BTC/SOL/ETH):
- fail_first 47.9% (stable across symbols, timeframes and direction)
- among breakouts: retest_go 31.8% / runner 30.2% / false_break 23.7% / chop 14.3%
- runner median excursion 3.1R in about 2 min vs retest 2.1R in about 10 min
- structure inside the flag (higher lows) is the strongest failure filter (58% → 35–44%)
- the owner's SOL 04:35Z case is labelled runner (5.3R)
- **Caveats:** one bull regime (`tdSide` was `bull` on every row); correlated samples.

**P1 — `pathOutlook` in the payload** (schema 1.19.0, config 2026.09.24-1):
- `lib/pathOutlook.js` picks the symbol's live flag and returns measured weights from a frozen backoff table (`config/engine.json` `pathOutlook`, built by `scripts/build-path-table.js` / `npm run paths:table`).
- Fields: `lean`, `likely`, `chase`, `n`, `cal`, `key`; separate tables before and after breakout.
- Info only.
- Payload 78,003 → 78,922 B (cap 79,000).

**P2 — GPT SCENARIO block** (`docs/GPT_INSTRUCTIONS.md`, 7,984 / 7,990 units):
- Renders `pathOutlook`; never invents percentages; "a runner without a retest is a missed entry".
- Budget trims also changed a few printed labels (e.g. `Available Collateral/Used Margin`, "Terse"). Reviewer: check nothing substantive was lost.

**P3 — calibration:**
- Capture rows keep whitelisted `pathOutlook` + `breakoutEntry`.
- `scripts/tracker/calibration.js`: Brier vs a baseline (realised frequencies in the joined set), likely-path hit rate, chase precision, reliability tables; tile `#path-calibration-section`.
- Live n was 1 at ship time.

**P4 — shadow breakout-close entry** (schema 1.20.0):
- `lib/breakoutEntry.js` + `scripts/tracker/breakout-entry.js`: on a runner-prone flag's breakout candle, entry = close, stop = invalidation, tp1 = measured target, gross ≥ 3 and stop ≤ 3%, `status: 'shadow'`.
- `lib/flagTradePlan.js` exports `netRiskReward`.
- **Not shown to the GPT, never a trade.**
- Replay (`docs/BREAKOUT_ENTRY_SHADOW.md`): gated shadow −0.65R net; retest entry on the same flags −0.35R net. **Not promoted.**
- Tracker `shadow.js` scores shadow vs retest live (`#breakout-shadow-section`).

## 6. T5 — Divergence opportunities (`docs/PLAN_DIVERGENCE_OPPORTUNITIES.md`)

**Request:** surface mentor-style early entries (divergence at support) as an OPPORTUNITY tier.

- **S1 — net R on the tracker:** `scripts/tracker/costs.js` (parity-tested vs config); `netExpectancy` / `avgCostR` in aggregates, hero, window tables, shadow tile; `outcomes.jsonl` untouched.
- **S2 — 60-day history:** backfill checkpoint now stores 1m candles (old format converts); 1h derived from 1m. Capture of `test/fixtures/history/deep60-2026-09-24/` **still running** (BTC at about 08-12 of 07-26 → 09-24 when last checked).
- **P0 — measure:**
  - `featuresAt` gained `divergence`, `atLevel`, `sweepReclaim`, `counterTrend`.
  - `scripts/replay-early-entry.js`.
  - Result (`docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`): early entry −0.65R net, retest −0.32R net. Divergence + support lowers fail_first 47.9% → about 43.5%, but **no early-entry combination is net-positive**. One retest-entry combo was +0.20R net at n=149 (1 of 24; likely noise until 60-day re-check). The mentor's case was not in the data.
  - **Decision:** OPPORTUNITY tier not built (P1–P3 not approved).

## 7. T6 — Fee-aware GOOD calls (plan by Thread A; execution by Thread B, ongoing)

**Evidence driving it:** the tracker's only ready fill, BTC 1m short on 09-24 11:57Z:
- entry 83,409.4 / stop 83,464.3 (**0.066%**) / tp1 83,228
- grossRR 3.30, netRR **0.07** → −1R gross, **−4.0R net**
- It was `ready` because the gate is gross-only (owner decision 1a).

Tracker plan stats (another session): 1m median stop 0.16%, 3m 0.29%, 5m 0.37%; almost no plan reaches net ≥ 1. The fee math is in the plan: at gross 3, net ≥ 2 needs a stop ≥ 0.6% at 0.20% cost.

**Plan:** `docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md` (supersedes `docs/PLAN_GOOD_QUALITY.md`, which was written by another session and folded in).

| Phase | Content |
| --- | --- |
| 0 | Replay variants: V0 baseline; V1 net gate 1.0/1.5/2.0; V2 15m/1h flags; V3 V2+net gate; V4 minRR 2.5 (research only); V5 lower-timeframe trigger + 15m structure stop; V6 ATR floor; V7 failed-flag reversal. Out-of-sample halves; pass = net > 0 in both halves and n ≥ 20. **Stops for an owner pick.** |
| 1 | Ship the pick; restart the testing window |
| 2 | Four-layer `state`, `?track=`, reversal scouts, watch-only divergence alerts |
| 3 | GPT rewrite |
| 4 | 60-day recalibration |
| 5 | Conditional path-informed gating |

**D3 cost reference** (Jupiter Perps docs): 0.06% open + 0.06% close; negligible price impact at small size; ~0.024%/h borrow; 0.10% per swap when collateral ≠ position asset. Round trip ≈ 0.12–0.14% (matching collateral) up to ≈ 0.32–0.34% (USDC-funded long). Config stays 0.20%; Phase 0 reports 0.14% and 0.34% sensitivity.

**Thread B state (uncommitted when this packet was written):**
- `config/engine.js` (+51): in-process config override hook for replay variants, default off
- `config/engine.json`: `flagPlan.minNetRR: null` (off); configVersion 2026.09.24-1 → **2026.09.24-2**
- `lib/flagTradePlan.js` (+7): net gate after the gross gate, reason `net_rr_below_min`, levels kept, only when `minNetRR` is finite
- `test-engine-config.js` (+72), `test-flag-trade-plan.js` (+44)
- `.gitignore`: `var/replay-rules/`
- Not yet visible: `scripts/replay-rules.js`, `docs/GOOD_QUALITY_REPLAY.md`

Reviewer: check the gate is truly inert with `minNetRR: null`, and whether a configVersion bump for a behaviour-neutral change is wanted (it changes the payload's `configVersion` on next deploy).

## 8. Tests (last full run by Thread A, before Thread B's changes)

All pass:

| Suite | n | Suite | n | Suite | n |
| --- | --- | --- | --- | --- | --- |
| scalp | 117 | pattern | 33 | tracker | 85 |
| sltp | 50 | geometry | 36 | journal | 17 |
| mcp | 52 | chart | 18 | served | 20 |
| wallet | 28 | replay | 45 | paths | 26 |
| config | 14 | bias | 15 | replay-paths | 28 |
| risk | 24 | freshness | 10 | outlook | 27 |
| flagplan | 43 | ledger | 12 | breakout | 33 |
| flagrec | 18 | topdown | 15 | | |
| flagrec:fixtures | 16 | evidence | 8 | | |
| mark | 12 | | | | |

Plus `check:gpt` OK (7,984 / 7,990), `git diff --check` clean.

## 9. Decisions the agents made that the reviewer should judge

1. **P4 shipped as shadow**, not as a GO entry, despite the owner asking to "get this live". Reason: gate change during a frozen testing window on provisional data. The replay later showed it is net-negative.
2. **OPPORTUNITY tier not built** after T5 P0 found no net-positive early entry.
3. **Extra credential guard** in served rows (beyond the plan).
4. **Test edits:** the journal isolation test's expected imports; `TRACK_SERVED_CALLS=false` in `test-scalp-context.js`; schemaVersion pins bumped in the config/geometry/pattern/scalp suites; fixture timing corrected after the labeller fix.
5. **Exports added to `lib/flagTradePlan.js`** (`observeRetestHold`, `netRiskReward`). Export only, no logic change.
6. **Candidate fields added to tracker capture rows** (`measuredTarget`, `compressionScore`, `durationCandles`, `impulseStrength`, `flagHigh`, `flagLow`, `pathOutlook`, `breakoutEntry`). These also flow into public served rows; all are engine market data, no account fields.
7. **GPT instruction budget trims** changed some printed labels.
8. **Costs kept at 0.20%** despite Jupiter docs suggesting 0.12–0.14% for matched collateral. Lowering costs to create calls is ruled out until real fills exist.
9. **Tracker page uses gross R** in the calibration and shadow tiles until net R was added (S1); resolved shadow rows written before S1 have no `netR` (frozen rows).

## 10. Known risks and open items

- Every quantitative claim rests on **one 15-day bullish window**. The 60-day capture is meant to fix that (T6 Phase 4).
- `pathOutlook` calibration is unproven live (n ≈ 1 at ship). If it doesn't beat baseline at n ≥ 30, rebuild or withdraw.
- Net expectancy is negative for all tested 1m–5m entry styles; T6 Phase 0 is the fix path.
- The GPT instruction budget is at 7,984 / 7,990. The owner must paste the new instructions into a **new** Custom GPT and import `openapi/scalp-context.yaml` (schema 1.20.0).
- Tracker commits tagged `[skip deploy]` mean the public tracker page may lag the data.
- The replay approximates the retest walk with an R-sized tolerance (0.15R) instead of the engine's ATR tolerance. `roomR` in the replay uses its own nearest-zone function, not `flagTradePlan`'s private cap.
- `PRODUCT.md` is untracked and belongs to neither thread; left alone.
- **Payload over cap - FIXED (T6 completion plan A1, `docs/PLAN_T6_COMPLETION_V2.md`,
  2026-09-24):** live had measured 79,863 B, over the documented 79,000 B default cap,
  on a busier-market day this packet's own review range never captured. Root cause:
  `breakoutEntry` (shadow-mode research, T4 P4) and four unread candidate fields
  (`flagSlope`/`breakoutDistancePct`/`invalidationDistancePct`/`levelSource`) were
  published unconditionally with no consumer reading them. Removed both; a new
  synthetic worst-case test (3 symbols x 6 simultaneous failed-in-TTL candidates + 1
  ready GOOD plan each, replacing the old frozen-fixture cap test that could not have
  caught this) measured 80,148 B even after the trim, so the default cap moved to a
  documented, minimal 80,200 B (compact unchanged at 45,000 B). Schema 1.22.0.

## 11. Where to look (quick index)

| Area | Files |
| --- | --- |
| Served calls | `api/scalp-context.js`, `lib/servedCalls.js`, `lib/blobJsonl.js`, `scripts/tracker/records.js`, `scripts/tracker/collect.js`, `test-served.js` |
| Path labelling / replay | `scripts/tracker/flag-paths.js`, `scripts/replay-paths.js`, `scripts/replay.js`, `test-flag-paths.js`, `test-replay-paths.js`, `test-replay.js` |
| Payload additions | `lib/pathOutlook.js`, `lib/breakoutEntry.js`, `services/scalpContext.js`, `config/engine.json` (`pathOutlook`), `openapi/scalp-context.yaml`, `test-path-outlook.js`, `test-breakout-entry.js` |
| Tracker steps | `scripts/tracker/{paths,calibration,shadow,costs,aggregate,build-page}.js`, `scripts/tracker/repo-template/.github/workflows/track.yml`, `test-tracker.js` |
| Studies | `scripts/replay-early-entry.js`, `scripts/replay-breakout-entry.js`, `scripts/build-path-table.js` |
| GPT | `docs/GPT_INSTRUCTIONS.md`, `scripts/check-gpt-instructions.js` |
| Results / plans | `docs/FLAG_PATHS_BASE_RATES.md`, `docs/BREAKOUT_ENTRY_SHADOW.md`, `docs/DIVERGENCE_OPPORTUNITIES_BASE_RATES.md`, `docs/PLAN_SERVED_CALLS.md`, `docs/PLAN_FLAG_PATHS.md`, `docs/PLAN_DIVERGENCE_OPPORTUNITIES.md`, `docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`, `CHANGELOG.md`, `docs/EDITTRADES_MCP_CONNECTOR.md` (work log) |

Reproduce any number:
- Tests: `npm run test:<suite>`.
- Replays: see the "Reproduce" sections in the result docs. Needs `test/fixtures/history/deep-2026-09-24/`, which is gitignored; re-capture with `node scripts/replay.js --capture BTC,SOL,ETH --out … --backfill-1m 20880`.
