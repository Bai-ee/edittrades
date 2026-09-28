# WP4 — R3b matched-random controls + Card 6.3 evidence for `re-flag-retest-1h`

Research only. Branch `edge/wp4-matched`, worktree `et-wp4-matched`. No engine/tracker files touched.

**Scripts:** `scripts/research/harness/matched-controls.js`, `scripts/research/harness/breakeven-per-trade.js`.
**Tests:** `test-matched-controls-wp4.js` (7/7 pass).
**Outputs:** `var/research/wp4-matched/{swing-deep60,swing-deep2y,breakeven,controls-deep2y,controls-deep2y-BTC,controls-deep2y-ETH,controls-deep2y-SOL}/` (gitignored, regenerate with the commands below).

## 1. Reproduction — and a fixture mislabel worth fixing

Command: `node scripts/swing/run.js --history <fixture> --rules re-flag-retest-1h,re-flag-retest-4h,re-flag-breakout-4h,re-random-4h --out-dir var/research/wp4-matched/<out>`.

**Finding: the published S3 numbers were generated on `deep2y-2026-09-26` (1m coverage 2024-10-01 → 2026-09-27, ~2 years), not the 85-day `deep60-2026-09-24` fixture the "(85d, aggregate)" label in `docs/research/BREAKEVEN_COSTS_2026-09-27.md` and the swing-study docs imply.**

- On `deep2y`, this run reproduces `docs/swing/re-flag-retest-1h.json` exactly: combined n=101, resolved=99, gross +0.4443R, net +0.2736R, OOS halves +0.186/+0.360. Signal timestamps run 2025-05-02 → 2026-09-19, ~16-17 months of usable window per symbol after warm-up — not 85 days.
- Siblings also match the "85d" rows in `BREAKEVEN_COSTS_2026-09-27.md` exactly when run on `deep2y`: `re-flag-retest-4h` n=48 gross -0.069, `re-flag-breakout-4h` n=38 gross +0.231, `re-random-4h` n=90 gross -0.048.
- On the literal 85-day `deep60-2026-09-24` fixture, `re-flag-retest-1h` only has **n=8** resolved signals (1m coverage too short to fit many 7-day-max-hold trades plus warm-up), gross **-0.65R** — far too small to mean anything, but it shows the "85 days" framing is not just imprecise, it describes a different (much weaker, negative-in-sample) run than the one actually behind the headline numbers.
- **Recommendation for the orchestrator:** correct the fixture attribution in `BREAKEVEN_COSTS_2026-09-27.md` / swing-study docs from "85 days" to `deep2y-2026-09-26` (~2 years) wherever the swing-rule rows are cited. Not fixed here (out of WP4 scope — those docs aren't listed as WP4's to edit).
- `deep2y-2026-09-26` is also the longest 1m-covered fixture available (checked all six `test/fixtures/history/*` dirs; next longest is `deep60-2026-09-24` at 85 days). Item 4 of this WP is answered by the fact the "reproduction" fixture already is the longest one.

## 2. Per-trade break-even (exact, n=99)

`node scripts/research/harness/breakeven-per-trade.js --in var/research/wp4-matched/swing-deep2y/re-flag-retest-1h.json`

Exact per-trade formula (same weighting as `scripts/research/edge/breakeven.js`'s `perTrade`, applied per-signal instead of the swing-row aggregate shortcut `grossExpR × medianStop` that script falls back to): `netR_i = grossR_i − (c + b·hours_i) / riskPct_i`; `hours_i = outcome.holdCandles / 60` (holdCandles are 1m candles in this harness).

Long share 47.5%, actual weighted round trip 0.1685% (0.20% long / 0.14% short).

| borrow scenario | break-even RT (aggregate) | margin vs actual | mean net R @ actual cost | median net R | share net R > 0 |
| --- | --- | --- | --- | --- | --- |
| no borrow | 0.620% | — | — | — | — |
| 0.02%/h (base, prior doc) | 0.306% | **1.82×** | 0.098R | -0.854R | 30.3% |
| 0.024%/h (Jupiter docs, prior doc) | 0.243% | **1.44×** | 0.053R | -0.940R | 30.3% |
| **0.0015%/h (measured today, coordinator update)** | 0.597% | **3.54×** | 0.307R | -0.738R | 30.3% |
| **0.004%/h (80% utilization stress, coordinator update)** | 0.557% | **3.31×** | 0.278R | -0.745R | 30.3% |

Aggregate max tolerable borrow at actual fees: **0.0287%/h** (exact) — vs. the prior aggregate-approximate table's 0.0448%/h for this same rule. **The exact per-trade method gives a materially tighter margin than the median-stop/median-hold approximation** (1.82× vs 2.18× at 0.02%/h) — stop size and hold time are correlated in a way the approximation misses. The qualitative "survives" verdict is unaffected because the median is negative (70% of trades lose — this is a low-win-rate, big-winner rule) but the *margin* claimed in the prior doc was optimistic.

**With the coordinator's measured Jupiter borrow (0.0013-0.0015%/h base, ~0.004%/h at 80% utilization) instead of the 0.02-0.024%/h this WP started with, borrow is no longer a binding constraint for this rule at all** — margin is 3.3-3.5×, and mean net R roughly triples (0.10R → 0.28-0.31R) versus the higher-borrow scenarios. This significantly changes Card 6's "borrow kills every slower strategy" framing for `re-flag-retest-1h` specifically: at real measured borrow, borrow costs this rule almost nothing (its median hold is 9.5h; the 0.29%/h delta between 0.02%/h and 0.0015%/h × ~9.5h ≈ 0.18% of entry ≈ 0.13R at the median stop — material at n=99 but not close to erasing the edge).

Per-trade rows: `var/research/wp4-matched/breakeven/per-trade.json`; summary: `.../summary.json`.

## 3. Matched-random controls (R3b)

`node scripts/research/harness/matched-controls.js --study var/research/wp4-matched/swing-deep2y/re-flag-retest-1h.json --history test/fixtures/history/deep2y-2026-09-26 --out-dir var/research/wp4-matched/controls-deep2y --k 100 --sims 2000 --boot 2000 --seed edittrades-wp4`

### Method (state the exact match, level and exit choices — see script header for full rationale)

- **Matched on:** symbol, side, timeframe/cadence (1h closes), UTC-hour bucket (4×6h), trailing-vol tercile (mean \|log return\| over the trailing 24h; tercile boundaries from a causal, expanding prefix recomputed every 168 candles — never uses a boundary derived from data at/after the classified candle), and HTF trend state (1D+4h EMA21/EMA200 stack+slope agreement — the same bull/bear gate `re-flag-retest-1h.js` itself uses). Fallback tiers (drop vol tercile, then drop hour bucket too) exist for thin pools but were **never needed**: all 99/99 real signals matched at the finest tier (exact hour+vol+trend match).
- **Levels:** the rule's own retest/flag level logic (`detectFlagLifecycle` + `retestPrintAt`) is only defined at a qualifying print, so per the WP4 brief's own stated fallback, a control reuses the **matched real trade's own stop distance (%) and R multiple**, anchored to the control candle's own close — not re-derived.
- **Exit:** stop / target / the same 168h hard cap, scored with the exact same `scoreSignal`/`walkOutcome` call the real study uses (same 1m candles, same fill window). **Controls do NOT get the real rule's structure-exit-back-inside-the-flag box** — there is no flag range to reference off-pattern. This is the one mechanic not reproduced for controls, and it cuts against the observed edge (controls that would have been stopped out slower ride to the cap instead, which can help or hurt their net R depending on where price ended up) — flagged, not hidden.
- **HTF trend state caveat:** computed from an expanding window from the start of the fixture, not the rule's own rolling 499-candle production window (`run.js`'s `PRODUCTION_FETCH_WINDOW`). Both are 100% causal; they can disagree near EMA200's slow-converging seed early in a rolling window. Not expected to matter much (EMA on a 2-year array vs. a 499-bar window converges to the same regime read almost everywhere), but not proven identical.
- **Costs:** 0.20% long / 0.14% short round trip; borrow at 0.02%/h and 0.024%/h (Jupiter docs, as WP4 started), **and** 0.0015%/h and 0.004%/h (coordinator's measured-today figures) — computed locally, identically for real and control trades (not the tracker's 34bps-long cost model).
- **K = 100** seeded control draws per real signal (9,700 pooled controls across 99 signals — a couple of signals produced <100 resolved controls where a drawn candle's own retest window ran off the fixture end). **S = 2,000** Monte-Carlo sims (one control per real trade per sim → a null distribution of study means with the same n and matching structure as the real study). **B = 2,000** block-bootstrap resamples of the observed mean, blocked by UTC calendar day (54 distinct days). Seed `edittrades-wp4`, deterministic (verified — see tests).

### Headline (combined, n=99)

| borrow scenario | observed mean R | control mean R (pooled, n=9,700) | percentile | p (one-sided) | bootstrap 95% CI of observed mean (54-day blocks) |
| --- | --- | --- | --- | --- | --- |
| 0.02%/h | **+0.098** | -0.338 | 98.9 | **0.011** | [-0.40, +0.60], median +0.10 |
| 0.024%/h | +0.053 | -0.406 | 99.0 | **0.010** | [-0.41, +0.58], median +0.05 |
| 0.0015%/h (measured) | +0.306 | -0.024 | 95.3 | **0.048** | [-0.21, +0.86], median +0.30 |
| 0.004%/h (stress) | +0.278 | -0.067 | 95.7 | **0.044** | [-0.21, +0.81], median +0.26 |

TP1 rate: observed 30.3% vs. control 24.9%. MFE: observed 1.58R vs. control 1.61R (similar). **MAE: observed 0.78R vs. control 0.93R** — the retest entry's specific timing draws down less before resolving than a random entry with the same stop/target/regime, which is the clearest single piece of evidence that the entry timing itself (not just "being in the right trend") is doing something.

**Two tests disagree on strength, and both are reported rather than picking the more favorable one:** the matched-random percentile/p-value says the observed mean sits in the top 1-5% of what chance alone (same regime, same stop/R, same costs) would produce, at every borrow scenario tested. The day-block bootstrap CI of the observed mean itself is wide enough to include zero in all four scenarios — 54 distinct trading days is not a lot of independent blocks, and trades cluster within trending stretches. Read together: there is a real, non-trivial signal in the entry timing beyond regime-matching, but the trade-level mean is not pinned down tightly enough to call this settled.

**Interesting finding on borrow sensitivity:** dropping borrow from 0.02%/h to the coordinator's measured 0.0015%/h raises both the observed mean (0.098→0.306R) and the control mean (-0.338→-0.024R) — cheap borrow helps the random controls more in relative terms (they ride to the 168h cap far more often, having no structure-exit escape valve), which is why the percentile *narrows* (98.9→95.3) even as the raw edge triples. The rule still clears p<0.05 one-sided at every borrow level tested, but the margin over "just being in the right regime" is smaller when borrow is cheap.

### Per symbol (K=100, same method; smaller n, noisier)

| symbol | n | observed mean R @0.02%/h | control mean R | percentile | p |
| --- | --- | --- | --- | --- | --- |
| BTC | 26 | +0.048 | -0.725 | 98.2 | 0.018 |
| SOL | 33 | +0.056 | -0.408 | 91.1 | 0.089 |
| ETH | 40 | +0.164 | -0.028 | 72.6 | 0.274 |

**The pooled significance is carried mainly by BTC and, to a lesser extent, SOL. ETH alone does not clear conventional significance** (p=0.24-0.35 across borrow scenarios) despite having the highest raw gross R of the three symbols in the original study — its control pool is also less negative (ETH's regime-matched random entries do better than BTC's/SOL's), so ETH's edge over "just being long ETH in an uptrend" is smaller. This should be weighed against combining all three symbols into one PAPER CANDIDATE without a per-symbol caveat.

Full report/per-signal files: `var/research/wp4-matched/controls-deep2y/{report.json,per-signal.json}`, per-symbol under `controls-deep2y-{BTC,ETH,SOL}/`.

## Tests

`node test-matched-controls-wp4.js` — 7/7 pass:
- eligibility buckets well-formed (hour bucket range, non-null trend/vol labels)
- vol-tercile boundaries are causal (truncating the array to a 60% prefix never changes an already-assigned label in that prefix)
- `hourBucketOf` bucketing
- **generator determinism**: identical seed → byte-identical `report.json` and per-signal control draws; a different seed changes the draws
- **controls respect matching buckets**: for tier-1 draws, every drawn control candle's own hour bucket / vol tercile / HTF state is re-derived from the eligibility table and asserted equal to the real signal's tuple
- **edgeless synthetic rule lands near the 50th percentile**: signals built by literally drawing from the same eligibility pool with the same fixed stop%/R-multiple as controls use (i.e., an admittedly-random "rule") land at percentile 64.0 (n=79 mixed long/short) — comfortably inside a wide, pre-registered [15,85] tolerance band. An offline 10-seed sweep of the same construction (not part of the committed test, `/tmp` scratch) showed a [24, 91.5] range with mean ≈58 at n≈40, confirming this is small-n sampling noise around 50, not a systematic bias in the matching/null machinery.

## Verdict

**`re-flag-retest-1h`: PAPER CANDIDATE**, with caveats:

1. It beats matched-random controls (same symbol/side/timeframe/hour/vol-regime/HTF-trend, same stop-%/R-multiple, same costs) at p ≈ 0.01-0.05 one-sided across all four borrow scenarios tested (2018-vintage 0.02/0.024%/h and today's measured 0.0015/0.004%/h) — not just "beats a coin flip," which is a materially stronger claim than the original study's OOS-halves-positive check alone supported.
2. At the coordinator's newly measured real Jupiter borrow (≈0.0015%/h base, ≈0.004%/h at 80% utilization), borrow is **not** a binding constraint for this rule — margin over actual round-trip cost is 3.3-3.5×, versus 1.4-1.8× under the 0.02-0.024%/h figures this WP started with and the prior BREAKEVEN doc used. This is good news for the strategy specifically, though it also means Card 6's "borrow kills every slower perps strategy" framing needs updating: at real borrow, the strategies rejected for being "borrow-kills" at 0.02-0.024%/h should be recomputed with the new figures before being treated as dead (out of WP4 scope — flagged for the orchestrator / a WP5/WP6 rerun).
3. Reasons to not call this settled: (a) the exact per-trade break-even margin is meaningfully tighter than the prior aggregate approximation at the old borrow figures; (b) the day-block bootstrap CI of the mean straddles zero in every scenario (54 independent day-blocks is thin); (c) the pooled significance is carried by BTC (and partly SOL) — ETH alone is not significant; (d) this is still one prior-inspected strategy (Card 4.2 multiple-testing discount applies — it was the single "survivor" identified out of ~79 rows in the break-even table); (e) controls don't get the structure-exit box, a real (if probably small) mechanical difference from the rule under test.
4. Recommended next step before treating this as tradeable: Jesse-bootstrap significance (R3, WP3) on this rule's raw entry series as a second, independent significance check that doesn't share this WP's matching assumptions; and a look at whether BTC-only (or BTC+SOL) is the more honest scope than "BTC/ETH/SOL combined."

Not REJECT: the matched-random evidence, not just the original OOS-halves check, now supports a real timing edge net of realistic costs. Not unconditional PAPER CANDIDATE either: the caveats above (symbol concentration, CI width, one-of-many-tested) mean this should go forward as a paper arm with per-symbol tracking, not a blanket green light.
