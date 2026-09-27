# Cost-gate study — 2026-09-26 (research only)

Owner question: does a **cost-to-risk gate** or a **minimum stop-distance floor**, applied
as a post-filter on top of the flag strategy's existing calls, turn the ~31% win rate /
~3R-planned baseline into positive **net** expectancy? **Research only** — no config/lib
change, no deploy, no push. All new files under `scripts/research/`, `var/cost-gate/`,
this doc.

## Method

- **Runner:** `scripts/replay-rules.js` (`VARIANTS`), same production pipeline
  (`scripts/replay.js`'s `buildAt`/`replaySymbol`, no lookahead) `docs/FREQUENCY_STUDY_2026-09-26.md`
  used. Its "Method" section's invocation style is reused verbatim.
- **Data:** `test/fixtures/history/deep60-2026-09-24/` — 2026-07-01T02:34Z →
  2026-09-24T14:33Z, 85.5 days, BTC/SOL/ETH.
- **Clock:** `--step 5` (per precedent — step 1 over 85.5 days would run ~45 min/variant).
  All three variants ran as parallel background processes; wall time ~11.5 min.
- **Variants run** (as requested; L1a/V7/etc. not run — out of scope for this study):
  - `L0` — live baseline (gross minRR 2.5, net gate off) — alias of `V0`.
  - `L1b` — gross minRR 2.0 (owner-rule-change variant, more candidates than L0).
  - `V6` — L1b's net gate (1.5) + stop floored at 0.5x ATR(15m), target fixed at 3x that
    stop (gross RR exactly 3 by construction) — the one variant in `VARIANTS` that
    structurally changes the stop, closest to a "minimum stop distance" mechanism already
    built into the harness.
  - Commands:
    ```
    node scripts/replay-rules.js --variant L0  --history test/fixtures/history/deep60-2026-09-24 --symbols BTC,SOL,ETH --step 5 --out var/cost-gate/L0.calls.jsonl  --summary var/cost-gate/L0.summary.json
    node scripts/replay-rules.js --variant L1b --history test/fixtures/history/deep60-2026-09-24 --symbols BTC,SOL,ETH --step 5 --out var/cost-gate/L1b.calls.jsonl --summary var/cost-gate/L1b.summary.json
    node scripts/replay-rules.js --variant V6  --history test/fixtures/history/deep60-2026-09-24 --symbols BTC,SOL,ETH --step 5 --out var/cost-gate/V6.calls.jsonl  --summary var/cost-gate/V6.summary.json
    ```
- **Post-filter grid** (`scripts/research/cost-gate-grid.js`, new, read-only over the
  `.calls.jsonl` outputs above): for each variant's scored calls, apply every combination
  of
  - `minStopPct` ∈ {none, 0.1, 0.3, 0.5, 0.8, 1.0, 1.4} (a floor on `stopDistancePct`,
    already a percent value in the scored rows), and
  - `maxCostR` ∈ {none, 0.25, 0.35, 0.5}, where `costR = dirCostPct / stopDistancePct`,
    `dirCostPct` = 0.34 (long) / 0.14 (short) — the owner's direction-dependent round-trip
    cost (`docs/OWNER_DECISIONS_2026-09-24.md` D-cost decision). This is a **post-filter
    only** — it removes calls from an already-scored, no-lookahead replay; it cannot
    invent trades or change how a kept trade resolved, so it's a valid way to test a gate
    without writing one into `lib/`.
  - "Dir-cost net R" per call = `netR_sens034` (0.34% round trip) for a long call,
    `netR_sens014` (0.14%) for a short call — verified directly against
    `scripts/replay-rules.js` lines 96–178 (`walkPlan`, `SENSITIVITY_ROUND_TRIP_PCT_HIGH`/
    `_LOW`, `DIR_COST_PCT_LONG`/`_SHORT`) before use.
  - **avg gross R** / **avg dir-cost net R** are *expectancy* figures (sum over all `n`
    calls in the cell, unresolved calls contributing 0, divided by `n`) — same convention
    `scripts/replay-rules.js`'s own `statsFor` uses, for comparability with
    `docs/FREQUENCY_STUDY_2026-09-26.md`.
  - **median net R**, **avg realized win R**, **avg realized loss R** are computed over
    *resolved* (win/loss) calls only.
  - **net breakeven win %** = `|avgLossR| / (avgWinR + |avgLossR|) × 100` — the win rate
    this cell's own win/loss size ratio would need to break even; compare against the
    cell's actual win %.
  - **max losing streak**: calls sorted by `firstReadyAt`, streak increments on `loss`,
    resets on `win` (unresolved calls don't reset it) — same rule as
    `scripts/replay-rules.js`'s `maxLosingStreak`.
  - **calls/day**: cell's `n` ÷ the fixture's full 85.5-day span (i.e., this shows the
    frequency *cost* of the gate against the unfiltered baseline, not the filtered
    subset's own day count).
  - **OOS split**: **first half vs second half of the full time span** (2026-07-01 →
    2026-08-12 vs 2026-08-12 → 2026-09-24) — a straight 50/50 split by calendar time, as
    this prompt specified. Note this **differs** from `scripts/replay-rules.js`'s own
    `splitHalves` (a 2/3-vs-1/3 split) used elsewhere in this repo — don't cross-compare
    OOS numbers between this doc and `docs/FREQUENCY_STUDY_2026-09-26.md` directly. Pass =
    net R > 0 in both halves (strict; a half with 0 or 1 call rounding to exactly 0 does
    **not** pass).
  - "Best 3 cells" = highest avg dir-cost net R among cells with `n ≥ 30`, tie-broken by
    `n` descending; long-only/short-only rows added for those three cells only.
- **Known issue carried over from `docs/FREQUENCY_STUDY_2026-09-26.md`**: calls with
  `stopDistancePct < 0.02%` explode `costR` and dominate the *unfiltered* mean net R (e.g.
  L0's unfiltered avg dir-cost net R is −7.56 vs. a median of only −2.30). Any
  `minStopPct ≥ 0.1` cell already excludes these outliers, so this only matters for the
  `none`/`none` baseline rows below.

## Baseline (unfiltered), for context

| Variant | n | resolved | win % | avg gross R | avg dir-cost net R | max losing streak | calls/day |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L0 | 425 | 421 | 30.9% | 0.563 | −7.560 | 13 | 4.97 |
| L1b | 685 | 681 | 34.7% | 0.458 | −5.416 | 15 | 8.01 |
| V6 | 479 | 467 | 26.6% | 0.061 | −0.454 | 17 | 5.60 |

V6's ATR floor alone (median stop 0.468%, vs. L0/L1b's ~0.12%) already pulls unfiltered
net R most of the way to breakeven, before any post-filter — the stop-distance mechanism
matters more than the specific variant's gross-RR gate.

## Full post-filter grids

### L0 (live baseline) — full post-filter grid (n=425 unfiltered, 85.5 days)

| minStop% | maxCostR | n | resolved | win% | avgGrossR | avgDirNetR | medNetR | avgWinR | avgLossR | BEwin% | maxStreak | calls/day | OOS 1st | OOS 2nd | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | none | 425 | 421 | 30.88% | 0.563 | -7.5603 | -2.3027 | -6.7376 | -8.0318 | 620.63% | 13 | 4.971 | -17.9947 | -2.9621 | false |
| none | 0.25 | 1 | 1 | 0% | -1 | -1.2349 | -1.2349 | - | -1.2349 | - | 1 | 0.012 | - | -1.2349 | false |
| none | 0.35 | 14 | 12 | 33.33% | 0.3027 | 0.0535 | -1.2714 | 2.7815 | -1.2972 | 31.8% | 3 | 0.164 | -1.3081 | 0.2804 | false |
| none | 0.5 | 37 | 33 | 36.36% | 0.4563 | 0.112 | -1.3132 | 2.7731 | -1.3872 | 33.34% | 7 | 0.433 | -0.6972 | 0.3009 | false |
| 0.1 | none | 234 | 230 | 31.3% | 0.3577 | -0.9177 | -1.7387 | 2.0368 | -2.2873 | 52.9% | 13 | 2.737 | -1.3738 | -0.7938 | false |
| 0.1 | 0.25 | 1 | 1 | 0% | -1 | -1.2349 | -1.2349 | - | -1.2349 | - | 1 | 0.012 | - | -1.2349 | false |
| 0.1 | 0.35 | 14 | 12 | 33.33% | 0.3027 | 0.0535 | -1.2714 | 2.7815 | -1.2972 | 31.8% | 3 | 0.164 | -1.3081 | 0.2804 | false |
| 0.1 | 0.5 | 37 | 33 | 36.36% | 0.4563 | 0.112 | -1.3132 | 2.7731 | -1.3872 | 33.34% | 7 | 0.433 | -0.6972 | 0.3009 | false |
| 0.3 | none | 83 | 79 | 31.65% | 0.3391 | -0.2902 | -1.4487 | 2.6482 | -1.672 | 38.7% | 9 | 0.971 | -1.1039 | -0.1912 | false |
| 0.3 | 0.25 | 1 | 1 | 0% | -1 | -1.2349 | -1.2349 | - | -1.2349 | - | 1 | 0.012 | - | -1.2349 | false |
| 0.3 | 0.35 | 14 | 12 | 33.33% | 0.3027 | 0.0535 | -1.2714 | 2.7815 | -1.2972 | 31.8% | 3 | 0.164 | -1.3081 | 0.2804 | false |
| 0.3 | 0.5 | 32 | 28 | 39.29% | 0.5742 | 0.2522 | -1.2956 | 2.8418 | -1.3641 | 32.43% | 6 | 0.374 | -1.084 | 0.4996 | false |
| 0.5 | none | 32 | 28 | 42.86% | 0.6876 | 0.271 | -1.3219 | 2.7228 | -1.5002 | 35.52% | 5 | 0.374 | 0 | 0.2797 | false |
| 0.5 | 0.25 | 1 | 1 | 0% | -1 | -1.2349 | -1.2349 | - | -1.2349 | - | 1 | 0.012 | - | -1.2349 | false |
| 0.5 | 0.35 | 7 | 5 | 60% | 1.0169 | 0.8291 | 2.6158 | 2.7644 | -1.2447 | 31.05% | 1 | 0.082 | - | 0.8291 | false |
| 0.5 | 0.5 | 18 | 14 | 57.14% | 1.1552 | 0.863 | 2.1569 | 2.9805 | -1.385 | 31.73% | 2 | 0.211 | 0 | 0.9138 | false |
| 0.8 | none | 9 | 6 | 83.33% | 1.913 | 1.6744 | 2.6742 | 3.2917 | -1.3893 | 29.68% | 1 | 0.105 | 0 | 1.8837 | false |
| 0.8 | 0.25 | 0 | 0 | - | - | - | - | - | - | - | 0 | 0 | - | - | false |
| 0.8 | 0.35 | 4 | 2 | 100% | 1.4805 | 1.3371 | 2.6742 | 2.6742 | - | - | 0 | 0.047 | - | 1.3371 | false |
| 0.8 | 0.5 | 9 | 6 | 83.33% | 1.913 | 1.6744 | 2.6742 | 3.2917 | -1.3893 | 29.68% | 1 | 0.105 | 0 | 1.8837 | false |
| 1 | none | 4 | 2 | 100% | 1.4805 | 1.3371 | 2.6742 | 2.6742 | - | - | 0 | 0.047 | - | 1.3371 | false |
| 1 | 0.25 | 0 | 0 | - | - | - | - | - | - | - | 0 | 0 | - | - | false |
| 1 | 0.35 | 4 | 2 | 100% | 1.4805 | 1.3371 | 2.6742 | 2.6742 | - | - | 0 | 0.047 | - | 1.3371 | false |
| 1 | 0.5 | 4 | 2 | 100% | 1.4805 | 1.3371 | 2.6742 | 2.6742 | - | - | 0 | 0.047 | - | 1.3371 | false |
| 1.4 | none | 0 | 0 | - | - | - | - | - | - | - | 0 | 0 | - | - | false |
| 1.4 | 0.25 | 0 | 0 | - | - | - | - | - | - | - | 0 | 0 | - | - | false |
| 1.4 | 0.35 | 0 | 0 | - | - | - | - | - | - | - | 0 | 0 | - | - | false |
| 1.4 | 0.5 | 0 | 0 | - | - | - | - | - | - | - | 0 | 0 | - | - | false |

### L0 (live baseline) — long-only vs short-only, best 3 cells

| cell (minStop/maxCostR) | side | n | resolved | win% | avgDirNetR | medNetR | avgWinR | avgLossR | BEwin% | maxStreak | calls/day | OOS 1st | OOS 2nd | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.5 / none | long | 29 | 25 | 44% | 0.2833 | -1.4475 | 2.7027 | -1.5367 | 36.25% | 5 | 0.339 | 0 | 0.2934 | false |
| 0.5 / none | short | 3 | 3 | 33.33% | 0.1518 | -1.2349 | 2.9448 | -1.2447 | 29.71% | 2 | 0.035 | - | 0.1518 | false |
| 0.3 / 0.5 | long | 15 | 11 | 63.64% | 1.0053 | 2.2376 | 2.9856 | -1.4551 | 32.77% | 2 | 0.175 | 0 | 1.0771 | false |
| 0.3 / 0.5 | short | 17 | 17 | 23.53% | -0.4123 | -1.3132 | 2.5902 | -1.3361 | 34.03% | 4 | 0.199 | -1.355 | -0.1222 | false |
| none / 0.5 | long | 15 | 11 | 63.64% | 1.0053 | 2.2376 | 2.9856 | -1.4551 | 32.77% | 2 | 0.175 | 0 | 1.0771 | false |
| none / 0.5 | short | 22 | 22 | 22.73% | -0.497 | -1.3259 | 2.4756 | -1.3712 | 35.65% | 5 | 0.257 | -0.8134 | -0.3783 | false |

### L1b (minRR 2.0) — full post-filter grid (n=685 unfiltered, 85.5 days)

| minStop% | maxCostR | n | resolved | win% | avgGrossR | avgDirNetR | medNetR | avgWinR | avgLossR | BEwin% | maxStreak | calls/day | OOS 1st | OOS 2nd | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | none | 685 | 681 | 34.65% | 0.4576 | -5.4164 | -2.0237 | -3.8948 | -6.272 | 263.84% | 15 | 8.012 | -12.8681 | -2.4082 | false |
| none | 0.25 | 6 | 6 | 33.33% | 0.0824 | -0.1301 | -1.2216 | 2.0648 | -1.2275 | 37.28% | 2 | 0.07 | - | -0.1301 | false |
| none | 0.35 | 32 | 30 | 36.67% | 0.2699 | 0.007 | -1.2448 | 2.2364 | -1.2829 | 36.45% | 6 | 0.374 | -1.3192 | 0.1442 | false |
| none | 0.5 | 71 | 67 | 37.31% | 0.3463 | -0.0036 | -1.2757 | 2.2917 | -1.3703 | 37.42% | 10 | 0.83 | -0.7777 | 0.0947 | false |
| 0.1 | none | 426 | 422 | 34.83% | 0.2975 | -0.9352 | -1.5937 | 1.4305 | -2.2133 | 60.74% | 12 | 4.982 | -1.1862 | -0.8735 | false |
| 0.1 | 0.25 | 6 | 6 | 33.33% | 0.0824 | -0.1301 | -1.2216 | 2.0648 | -1.2275 | 37.28% | 2 | 0.07 | - | -0.1301 | false |
| 0.1 | 0.35 | 32 | 30 | 36.67% | 0.2699 | 0.007 | -1.2448 | 2.2364 | -1.2829 | 36.45% | 6 | 0.374 | -1.3192 | 0.1442 | false |
| 0.1 | 0.5 | 71 | 67 | 37.31% | 0.3463 | -0.0036 | -1.2757 | 2.2917 | -1.3703 | 37.42% | 10 | 0.83 | -0.7777 | 0.0947 | false |
| 0.3 | none | 143 | 139 | 37.41% | 0.3605 | -0.2452 | -1.3414 | 2.0542 | -1.6309 | 44.26% | 6 | 1.673 | -0.9111 | -0.1898 | false |
| 0.3 | 0.25 | 6 | 6 | 33.33% | 0.0824 | -0.1301 | -1.2216 | 2.0648 | -1.2275 | 37.28% | 2 | 0.07 | - | -0.1301 | false |
| 0.3 | 0.35 | 32 | 30 | 36.67% | 0.2699 | 0.007 | -1.2448 | 2.2364 | -1.2829 | 36.45% | 6 | 0.374 | -1.3192 | 0.1442 | false |
| 0.3 | 0.5 | 62 | 58 | 39.66% | 0.4293 | 0.0991 | -1.2583 | 2.3178 | -1.3475 | 36.76% | 8 | 0.725 | -1.1269 | 0.2305 | false |
| 0.5 | none | 62 | 58 | 48.28% | 0.6916 | 0.2808 | -1.2216 | 2.1551 | -1.4312 | 39.91% | 4 | 0.725 | 0 | 0.2854 | false |
| 0.5 | 0.25 | 6 | 6 | 33.33% | 0.0824 | -0.1301 | -1.2216 | 2.0648 | -1.2275 | 37.28% | 2 | 0.07 | - | -0.1301 | false |
| 0.5 | 0.35 | 21 | 19 | 42.11% | 0.4331 | 0.1967 | -1.2309 | 2.2472 | -1.2587 | 35.9% | 5 | 0.246 | - | 0.1967 | false |
| 0.5 | 0.5 | 38 | 34 | 50% | 0.7733 | 0.4681 | 0.1913 | 2.3727 | -1.3264 | 35.86% | 7 | 0.444 | 0 | 0.4808 | false |
| 0.8 | none | 16 | 13 | 76.92% | 1.6236 | 1.3642 | 1.9197 | 2.5773 | -1.3154 | 33.79% | 1 | 0.187 | 0 | 1.4551 | false |
| 0.8 | 0.25 | 3 | 3 | 66.67% | 1.1649 | 0.9724 | 1.9197 | 2.0648 | -1.2124 | 37% | 1 | 0.035 | - | 0.9724 | false |
| 0.8 | 0.35 | 10 | 8 | 75% | 1.2669 | 1.0511 | 1.8949 | 2.1779 | -1.2785 | 36.99% | 1 | 0.117 | - | 1.0511 | false |
| 0.8 | 0.5 | 16 | 13 | 76.92% | 1.6236 | 1.3642 | 1.9197 | 2.5773 | -1.3154 | 33.79% | 1 | 0.187 | 0 | 1.4551 | false |
| 1 | none | 8 | 6 | 83.33% | 1.4509 | 1.2669 | 2.0648 | 2.2696 | -1.2124 | 34.82% | 1 | 0.094 | - | 1.2669 | false |
| 1 | 0.25 | 3 | 3 | 66.67% | 1.1649 | 0.9724 | 1.9197 | 2.0648 | -1.2124 | 37% | 1 | 0.035 | - | 0.9724 | false |
| 1 | 0.35 | 8 | 6 | 83.33% | 1.4509 | 1.2669 | 2.0648 | 2.2696 | -1.2124 | 34.82% | 1 | 0.094 | - | 1.2669 | false |
| 1 | 0.5 | 8 | 6 | 83.33% | 1.4509 | 1.2669 | 2.0648 | 2.2696 | -1.2124 | 34.82% | 1 | 0.094 | - | 1.2669 | false |
| 1.4 | none | 1 | 1 | 0% | -1 | -1.2124 | -1.2124 | - | -1.2124 | - | 1 | 0.012 | - | -1.2124 | false |
| 1.4 | 0.25 | 1 | 1 | 0% | -1 | -1.2124 | -1.2124 | - | -1.2124 | - | 1 | 0.012 | - | -1.2124 | false |
| 1.4 | 0.35 | 1 | 1 | 0% | -1 | -1.2124 | -1.2124 | - | -1.2124 | - | 1 | 0.012 | - | -1.2124 | false |
| 1.4 | 0.5 | 1 | 1 | 0% | -1 | -1.2124 | -1.2124 | - | -1.2124 | - | 1 | 0.012 | - | -1.2124 | false |

### L1b (minRR 2.0) — long-only vs short-only, best 3 cells

| cell (minStop/maxCostR) | side | n | resolved | win% | avgDirNetR | medNetR | avgWinR | avgLossR | BEwin% | maxStreak | calls/day | OOS 1st | OOS 2nd | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.5 / 0.5 | long | 26 | 22 | 63.64% | 0.8445 | 1.7389 | 2.3726 | -1.4074 | 37.23% | 2 | 0.304 | 0 | 0.8783 | false |
| 0.5 / 0.5 | short | 12 | 12 | 25% | -0.3475 | -1.2448 | 2.3732 | -1.2544 | 34.58% | 7 | 0.14 | - | -0.3475 | false |
| 0.5 / none | long | 50 | 46 | 54.35% | 0.4316 | 1.509 | 2.129 | -1.507 | 41.45% | 4 | 0.585 | 0 | 0.4404 | false |
| 0.5 / none | short | 12 | 12 | 25% | -0.3475 | -1.2448 | 2.3732 | -1.2544 | 34.58% | 7 | 0.14 | - | -0.3475 | false |
| 0.3 / 0.5 | long | 26 | 22 | 63.64% | 0.8445 | 1.7389 | 2.3726 | -1.4074 | 37.23% | 2 | 0.304 | 0 | 0.8783 | false |
| 0.3 / 0.5 | short | 36 | 36 | 25% | -0.4392 | -1.2826 | 2.2325 | -1.3298 | 37.33% | 7 | 0.421 | -1.3522 | -0.2919 | false |

### V6 (ATR-floored stop, 3x fixed RR) — full post-filter grid (n=479 unfiltered, 85.5 days)

| minStop% | maxCostR | n | resolved | win% | avgGrossR | avgDirNetR | medNetR | avgWinR | avgLossR | BEwin% | maxStreak | calls/day | OOS 1st | OOS 2nd | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none | none | 479 | 467 | 26.55% | 0.0605 | -0.4541 | -1.3398 | 2.4551 | -1.5217 | 38.26% | 17 | 5.602 | -0.6212 | -0.3932 | false |
| none | 0.25 | 64 | 60 | 20% | -0.1875 | -0.3678 | -1.181 | 2.8007 | -1.1906 | 29.83% | 14 | 0.749 | -0.249 | -0.4042 | false |
| none | 0.35 | 162 | 155 | 23.87% | -0.0437 | -0.2907 | -1.2328 | 2.7323 | -1.2559 | 31.49% | 19 | 1.895 | -0.1136 | -0.3653 | false |
| none | 0.5 | 262 | 252 | 26.59% | 0.0607 | -0.24 | -1.2668 | 2.6696 | -1.3068 | 32.86% | 17 | 3.064 | -0.2792 | -0.2237 | false |
| 0.1 | none | 479 | 467 | 26.55% | 0.0605 | -0.4541 | -1.3398 | 2.4551 | -1.5217 | 38.26% | 17 | 5.602 | -0.6212 | -0.3932 | false |
| 0.1 | 0.25 | 64 | 60 | 20% | -0.1875 | -0.3678 | -1.181 | 2.8007 | -1.1906 | 29.83% | 14 | 0.749 | -0.249 | -0.4042 | false |
| 0.1 | 0.35 | 162 | 155 | 23.87% | -0.0437 | -0.2907 | -1.2328 | 2.7323 | -1.2559 | 31.49% | 19 | 1.895 | -0.1136 | -0.3653 | false |
| 0.1 | 0.5 | 262 | 252 | 26.59% | 0.0607 | -0.24 | -1.2668 | 2.6696 | -1.3068 | 32.86% | 17 | 3.064 | -0.2792 | -0.2237 | false |
| 0.3 | none | 479 | 467 | 26.55% | 0.0605 | -0.4541 | -1.3398 | 2.4551 | -1.5217 | 38.26% | 17 | 5.602 | -0.6212 | -0.3932 | false |
| 0.3 | 0.25 | 64 | 60 | 20% | -0.1875 | -0.3678 | -1.181 | 2.8007 | -1.1906 | 29.83% | 14 | 0.749 | -0.249 | -0.4042 | false |
| 0.3 | 0.35 | 162 | 155 | 23.87% | -0.0437 | -0.2907 | -1.2328 | 2.7323 | -1.2559 | 31.49% | 19 | 1.895 | -0.1136 | -0.3653 | false |
| 0.3 | 0.5 | 262 | 252 | 26.59% | 0.0607 | -0.24 | -1.2668 | 2.6696 | -1.3068 | 32.86% | 17 | 3.064 | -0.2792 | -0.2237 | false |
| 0.5 | none | 207 | 197 | 26.4% | 0.0531 | -0.3115 | -1.2459 | 2.6182 | -1.3837 | 34.58% | 11 | 2.421 | -0.4115 | -0.2845 | false |
| 0.5 | 0.25 | 64 | 60 | 20% | -0.1875 | -0.3678 | -1.181 | 2.8007 | -1.1906 | 29.83% | 14 | 0.749 | -0.249 | -0.4042 | false |
| 0.5 | 0.35 | 106 | 100 | 26% | 0.0377 | -0.1759 | -1.2018 | 2.7539 | -1.2196 | 30.69% | 13 | 1.24 | -0.0655 | -0.2136 | false |
| 0.5 | 0.5 | 139 | 130 | 30% | 0.1871 | -0.0698 | -1.2027 | 2.692 | -1.2603 | 31.89% | 12 | 1.626 | 0.0278 | -0.0978 | false |
| 0.8 | none | 50 | 45 | 35.56% | 0.38 | 0.1522 | -1.132 | 2.6927 | -1.2232 | 31.24% | 6 | 0.585 | 0.4226 | 0.1082 | true |
| 0.8 | 0.25 | 24 | 22 | 18.18% | -0.25 | -0.3867 | -1.1321 | 2.8242 | -1.1432 | 28.81% | 7 | 0.281 | 0.5539 | -0.521 | false |
| 0.8 | 0.35 | 36 | 33 | 30.3% | 0.1944 | 0.0089 | -1.132 | 2.7423 | -1.1784 | 30.06% | 7 | 0.421 | 0.0816 | -0.0002 | false |
| 0.8 | 0.5 | 50 | 45 | 35.56% | 0.38 | 0.1522 | -1.132 | 2.6927 | -1.2232 | 31.24% | 6 | 0.585 | 0.4226 | 0.1082 | true |
| 1 | none | 21 | 19 | 31.58% | 0.2381 | 0.0382 | -1.1186 | 2.7118 | -1.1899 | 30.5% | 7 | 0.246 | -1.3355 | 0.1069 | false |
| 1 | 0.25 | 10 | 9 | 11.11% | -0.5 | -0.6139 | -1.1186 | 2.803 | -1.1177 | 28.51% | 5 | 0.117 | - | -0.6139 | false |
| 1 | 0.35 | 21 | 19 | 31.58% | 0.2381 | 0.0382 | -1.1186 | 2.7118 | -1.1899 | 30.5% | 7 | 0.246 | -1.3355 | 0.1069 | false |
| 1 | 0.5 | 21 | 19 | 31.58% | 0.2381 | 0.0382 | -1.1186 | 2.7118 | -1.1899 | 30.5% | 7 | 0.246 | -1.3355 | 0.1069 | false |
| 1.4 | none | 3 | 2 | 50% | 0.6667 | 0.5683 | 0.8525 | 2.803 | -1.098 | 28.15% | 1 | 0.035 | - | 0.5683 | false |
| 1.4 | 0.25 | 3 | 2 | 50% | 0.6667 | 0.5683 | 0.8525 | 2.803 | -1.098 | 28.15% | 1 | 0.035 | - | 0.5683 | false |
| 1.4 | 0.35 | 3 | 2 | 50% | 0.6667 | 0.5683 | 0.8525 | 2.803 | -1.098 | 28.15% | 1 | 0.035 | - | 0.5683 | false |
| 1.4 | 0.5 | 3 | 2 | 50% | 0.6667 | 0.5683 | 0.8525 | 2.803 | -1.098 | 28.15% | 1 | 0.035 | - | 0.5683 | false |

### V6 (ATR-floored stop, 3x fixed RR) — long-only vs short-only, best 3 cells

| cell (minStop/maxCostR) | side | n | resolved | win% | avgDirNetR | medNetR | avgWinR | avgLossR | BEwin% | maxStreak | calls/day | OOS 1st | OOS 2nd | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.8 / none | long | 27 | 24 | 54.17% | 0.7294 | 2.581 | 2.6607 | -1.3542 | 33.73% | 5 | 0.316 | 0.3242 | 0.7998 | true |
| 0.8 / none | short | 23 | 21 | 14.29% | -0.5253 | -1.1322 | 2.8312 | -1.1432 | 28.76% | 11 | 0.269 | 0.5539 | -0.6872 | false |
| 0.8 / 0.5 | long | 27 | 24 | 54.17% | 0.7294 | 2.581 | 2.6607 | -1.3542 | 33.73% | 5 | 0.316 | 0.3242 | 0.7998 | true |
| 0.8 / 0.5 | short | 23 | 21 | 14.29% | -0.5253 | -1.1322 | 2.8312 | -1.1432 | 28.76% | 11 | 0.269 | 0.5539 | -0.6872 | false |
| 0.8 / 0.35 | long | 13 | 12 | 58.33% | 0.954 | 2.6688 | 2.7042 | -1.3055 | 32.56% | 4 | 0.152 | -1.3355 | 1.1448 | false |
| 0.8 / 0.35 | short | 23 | 21 | 14.29% | -0.5253 | -1.1322 | 2.8312 | -1.1432 | 28.76% | 11 | 0.269 | 0.5539 | -0.6872 | false |

## Reading

1. **Only one cell in the entire 84-cell × 3-variant sweep passes the strict OOS rule with
   a defensible `n`:** `V6`, `minStopPct ≥ 0.8`, any `maxCostR` cap ≥ 0.35 — n=50 (45
   resolved), win 35.6%, avg dir-cost net R **+0.152**, both halves positive (+0.42 / +0.11).
   That beats the plain flag pipeline (`L0`/`L1b`) at every stop/cost threshold tried.
2. **It's not the cost-ratio gate doing the work — it's the flat stop floor.** For `V6`,
   `maxCostR` alone (no `minStopPct`) never turns net R positive (worst: −0.37 at
   `maxCostR=0.25`); only raising `minStopPct` to 0.8% does. For `L0`/`L1b`, a `maxCostR`
   cap alone gets close to breakeven (`L0` none/0.35 = +0.05, n=14; `L1b` none/0.35 =
   +0.007, n=32) but never clears real `n` with an OOS pass — nearly every positive cell in
   `L0`/`L1b` has 0–1 calls in the first half of the span, which is a sample artifact, not a
   genuine OOS pass (flagged `pass=false` throughout their grids for exactly this reason).
3. **The V6 "pass" is a long-only effect, not a cost-gate effect.** Splitting the
   `V6 0.8/none` cell: **long** n=27, win 54.2%, net R **+0.729**, OOS +0.32 / +0.80 (passes
   on its own); **short** n=23, win 14.3%, net R **−0.525**, OOS +0.55 / **−0.69** (fails,
   badly — 11-trade losing streak). Combining them nets positive only because longs (2.4x
   more calls, much better win rate) outweigh a badly negative short book. The same
   asymmetry shows in every variant's best-cell breakdown: `L0`'s best 3 cells are long
   +0.15 to +1.01 vs. short −0.41 to −0.50; `L1b`'s are long +0.43 to +0.84 vs. short
   consistently ≈ −0.35 to −0.44. **Shorts never clear breakeven in any gate or variant
   tried here.**
4. **Verdict: no, not convincingly.** A cost-to-risk gate on its own does not turn this
   strategy net-positive at any threshold tried, on either `L0` or `L1b`. A flat
   minimum-stop-distance floor (~0.8%+) *does*, but only in combination with `V6`'s ATR-
   floored stop construction, only for longs, and only at n≈27–50 — thin enough that this
   reads as a promising, narrow lead worth a dedicated follow-up study, not a settled
   result.
5. **Cost, in frequency:** the one passing cell (`V6`, minStopPct 0.8) runs at **0.585
   calls/day**, ~10% of `V6`'s own unfiltered rate (5.60/day) and ~12% of `L0`'s baseline
   rate (4.97/day) — call it "one GOOD call every 1.7 days," a large frequency cost for the
   only lead that passes.
6. **Sample-size flags (be explicit about these before acting on any of the above):**
   - The passing `V6` cell's OOS first half has only **n=7** total (4 long) — a single bad
     week could flip that half negative. n≥30 as a floor is doing real work at these
     thresholds; most of the grid's "interesting" cells (win% 60–100%, avg net R > 1) sit
     at n=1–10 and are almost certainly noise (see `L0`/`L1b` rows at `minStopPct ≥ 0.8`:
     100% win rates on n=2–9 calls).
   - This is a single 85.5-day fixture on one exchange (Kraken); `docs/FREQUENCY_STUDY_2026-09-26.md`
     already flagged that this fixture's July–August portion carries data-quality outliers
     and a possibly different regime from the September window the original 15-day study
     covered. That caveat applies here too, though `minStopPct` filters already remove the
     specific near-zero-stop outliers it named.
   - No walk-forward re-optimization was done — the "best 3 cells" were picked by scanning
     the same data the OOS split reports on, which is the standard in-sample selection bias
     every grid search has. Treat the V6-longs-0.8%+ finding as a hypothesis to re-test on
     fresh data, not a rule to ship.

## Addendum 2026-09-27 — leverage-aware long cost

The 0.34% long cost (D-cost) charges Jupiter's 0.10% swap fee on the full notional. Jupiter's
fee page (https://docs.jup.ag/user-docs/trade/perps/fees) applies the swap fee to "the
collateral swapped", so at leverage L the round-trip swap is 0.20% / L of notional. Long
round trip ≈ 0.12% open/close + 0.20%/L + borrow (~0.024%/h): ~0.20% at 3x, ~0.15% at 10x.
Not yet confirmed against a real fill. Short cost unchanged (0.14%).

Re-scored with `scripts/research/rescore-long-cost.js` (post-hoc, no re-replay). Selected cells:

| variant | min stop % | n | win % | net R @0.34 | net R @0.20 | net R @0.15 | OOS @0.15 (1st / 2nd) |
|---|---|---|---|---|---|---|---|
| L0 | 0.1 | 230 | 30–31 | −0.93 | −0.52 | −0.37 | −0.71 / −0.28 |
| L0 | 0.3 | 79 | 31.6 | −0.31 | −0.06 | +0.02 | −0.95 / +0.13 |
| L1b | 0.3 | 139 | 37.4 | −0.25 | −0.03 | +0.05 | −0.72 / +0.11 |
| V6 | 0.5 | 197 | 26.4 | −0.33 | −0.21 | −0.17 | −0.42 / −0.11 |
| V6 | 0.8 | 45 | 35.6 | +0.17 | +0.25 | +0.27 | +0.84 / +0.22 (pass) |

At 0.15%, V6 ≥0.8% splits long n=24 +1.01R (54% win) vs short n=21 −0.58R. Shorts already
carry the cheap cost, so the short loss is not a fee effect.

Reading: the corrected cost adds ~0.1–0.4R per trade but does not create an edge on its own.
L0/L1b reach roughly breakeven at a 0.3% floor and still fail the split. The V6 ≥0.8% lead
is unchanged in shape; the same sample-size and selection-bias caveats apply.

Sizing on the V6 ≥0.8% @0.15 cell (`scripts/research/risk-sim.js`, 10k bootstrap paths × 300
trades, 1 trade/day; `var/risk-sim/cg-V6-min08-L015.json`):

| risk/trade | median final | p95 max DD | P(DD ≥ 20%) | longest losing streak (median / p95) |
|---|---|---|---|---|
| 0.5% | 1.47x | 14.7% | 0.5% | 11 / 17 |
| 0.75% | 1.80x | 21.8% | 8.3% | 11 / 17 |
| 1% | 2.16x | 27.7% | 27.0% | 11 / 17 |
| 2% | 4.18x | 48.8% | 96.2% | 11 / 17 |

## Files

- `scripts/research/cost-gate-grid.js` — the post-filter grid tool (new, read-only over
  `.calls.jsonl`).
- `var/cost-gate/{L0,L1b,V6}.calls.jsonl` — raw scored calls per variant.
- `var/cost-gate/{L0,L1b,V6}.summary.json` / `.log` — `replay-rules.js`'s own summary/console output.
- `var/cost-gate/{L0,L1b,V6}.grid.json` — full grid + best-3-cell long/short splits, machine-readable.
- `scripts/research/rescore-long-cost.js` — re-scores `.calls.jsonl` at alternative long costs (addendum).
