# T-20 — HTF-anchored entry replay results

Generated 2026-09-27/28 per `docs/PROMPT_T20_HTF_ENTRY.md` deliverable 4 (worktree
`snapshot_tradingview-htf`, branch `htf-entry`, off `origin/upgrade-signal-engine`).
Numbers only, no recommendation — the owner already decided to ship this rule live in the
same phase (`docs/OWNER_DECISIONS_2026-09-27.md` "T-20"); this replay does not gate that
release.

**Fixture**: `test/fixtures/history/deep2y-2026-09-26` (2024-10-01 → 2026-09-27, ~103.7
weeks — the same span `docs/RETEST_ENTRY_STUDY_2026-09-27.md` quotes for this identical
fixture), BTC/SOL/ETH, run at every closed 1m candle. This is the first 1-minute-cadence
rule ever run through `scripts/swing/run.js` (every prior swing rule signals at 1h/4h/1d
cadence, 60–1,440× fewer `signalAt` calls over the same span); each of the three rules
below took ~12.3–12.8 million ms (~3.4–3.5 hours) to complete, run as three parallel
processes (`node --max-old-space-size=20480 scripts/swing/run.js --history
test/fixtures/history/deep2y-2026-09-26 --symbols BTC,SOL,ETH --rules <id> --out-dir
docs/swing`). An earlier draft of this doc shipped a smaller `deep60-2026-09-24` (~12.2
week) interim while the full run was still computing; this revision replaces it with the
complete 2-year results.

## Rules and controls (`scripts/swing/rules/`)

- **`htf-entry-1m`** — the live rule (`lib/htfEntryRule.js`, re-exported unchanged, same
  precedent as `re-flag-retest-1h.js`/`lib/retest1hRule.js`): direction from the 4h+1D
  EMA21/EMA200 stack (long when EMA21 > EMA200 on BOTH and price > EMA21(4h), short
  mirrored, no slope requirement), entry from a 1m/5m flag (`lib/patternDetector.js`)
  reaching `triggering` in that direction, stop the 1h swing anchor ± 0.1×ATR(1h)
  NF-floored (`max(0.5×ATR15m, 3×round-trip cost)`, gated — never widened — by the 3%
  scalp cap), target the last 1h impulse projected from that same anchor (≥2.5R gross,
  ≥1.0R net off the floored stop, else no trade).
- **`ctl-htf-random-1m`** (control) — identical trigger/stop/target/gates, direction is a
  seeded coin flip (`RANDOM_SEED=2026`, FNV-1a → mulberry32, same technique as
  `ctl-random-4h.js`/`re-random-4h.js`/`mr-random-1h.js`) instead of the 4h+1D stack.
  Isolates what the direction gate is worth.
- **`ctl-htf-15mstop-1m`** (control) — identical direction/trigger, stop/target computed
  from `buildHtfPlan`'s own swing math run on the 15m series instead of 1h. Isolates what
  anchoring to 1h structure specifically is worth against a tighter, faster 15m read.

3m skipped in this harness (no native 3m fixture — the harness's own convention: "3m is
derived production-side and not reconstructed here," same as every prior swing study);
the live wiring checks 3m too.

## Method

- **Scorer**: `scripts/swing/run.js` `scoreSignal` with each rule's own `holdRule`
  (`lib/htfEntryRule.js` `htfStructureHoldRule`) — same fill/stop/target walk every prior
  swing study uses (same-candle stop still loses; a target touch only counts on a later
  candle than the fill), plus the structure-exit addition: one 1h-interval close beyond
  the anchor-defined `structureStop` in the wrong direction exits the trade (`n:1` on a
  one-sided inside band — see `htfStructureHoldRule`'s own docstring). A trade still open
  at the 72h cap is closed at that candle's close, mark-to-market (`timeout`).
- **Structure-exit approximation (replay only, disclosed, owner-reviewed — see
  `docs/OWNER_DECISIONS_2026-09-27.md` "T-20")**: the harness's `holdRule` mechanism
  samples periodically from the signal's OWN trigger time (`fromMs + k×3,600,000`), not
  recalendared to real exchange 1h boundaries. The live alert (`lib/htfEntryLive.js`)
  checks the real 1h close directly and is unaffected by this approximation.
  `ctl-htf-15mstop-1m` samples at 1h intervals too (the hold-rule granularity is fixed
  across all three rules for comparability, even though that control's own stop is
  15m-anchored).
- **Cost**: `scripts/tracker/costs.js` `netR`, direction-dependent — 0.34% round-trip
  long, 0.14% short (funding asymmetry, USDC/USDT-margined perps) — the same model
  `lib/flagTradePlan.js`/the live tracker use.
- **Gross vs net R**: gross R is the raw walked outcome (a full stop = −1R by
  construction); net R subtracts the round-trip cost as a fraction of the trade's own risk.
- **Bootstrap 90% lower bound**: `scripts/tracker/aggregate.js` `bootstrapMeanLowerBound90`
  — the SAME seeded (1,000 resamples) function the live tracker's `RETEST_1H`/`HTF_1M`
  classes use — applied to net R.
- **Filled %**: resolved (`win`/`loss`/`timeout`/`structure_exit`) ÷ every fired signal;
  the remainder is `not_filled`. Entry is the trigger candle's own close (prefilled), same
  convention `re-flag-retest-1h` uses, so this reads high (92–98%) across every rule here.
- **Median stop %**: over every fired signal (not just resolved) — `|entry−stop|/entry×100`.
- **Median hold**: hours, over resolved signals only (`outcome.holdCandles / 60`).
- **Signals/week**: `n ÷ 103.7` weeks.
- **OOS split**: harness convention (`splitHalves`-style, index-based within the combined
  row's concatenated symbol order) — median AND mean net R, both halves, same convention
  `docs/RETEST_ENTRY_STUDY_2026-09-27.md` uses.
- **Histogram**: gross R, resolved signals only, bucketed `(-∞,0]` labeled `-1`, `(0,1]`,
  `(1,2]`, `(2,3]`, `(3,∞)` labeled `≥3` — same buckets `scripts/swing/analyze-retest.js`
  uses for the S3 study.
- Generated with `scripts/swing/analyze-htf.js <rule-id>` (read-only, no fixture re-run;
  extends `analyze-retest.js`'s median/mean/histogram math with the bootstrap lower bound
  and signals/week columns this study's own table needs) against the raw per-signal JSON
  `scripts/swing/run.js` writes to `docs/swing/<id>.json`.

## Results — `deep2y-2026-09-26` (~103.7 weeks, 2024-10-01 → 2026-09-27)

### htf-entry-1m — the live rule

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | net R 90% LB | median stop % | median hold h | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 536 | 97.57% | 29.06% | 0.221 | -1.000 | -0.043 | -1.154 | -0.148 | 0.47% | 2.72 | 5.169 |
| SOL | 627 | 93.94% | 28.69% | 0.119 | -1.000 | -0.125 | -1.124 | -0.237 | 0.62% | 1.05 | 6.046 |
| ETH | 613 | 92.17% | 25.49% | -0.118 | -1.000 | -0.374 | -1.186 | -0.465 | 0.67% | 2.27 | 5.911 |
| combined | 1776 | 94.43% | 27.73% | 0.071 | -1.000 | -0.183 | -1.151 | -0.248 | 0.58% | 2.02 | 17.126 |

OOS (net R): median 1st/2nd half −1.128 / −1.171; mean 1st/2nd half −0.008 / −0.358.

R histogram (gross, resolved, n=1677): `-1`: 1212 · `0–1`: 173 · `1–2`: 6 · `2–3`: 79 · `≥3`: 207

### ctl-htf-random-1m — control (seeded random direction)

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | net R 90% LB | median stop % | median hold h | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 3379 | 96.12% | 26.42% | -0.123 | -1.000 | -0.397 | -1.124 | -0.430 | 0.61% | 2.28 | 32.584 |
| SOL | 4259 | 94.51% | 27.06% | -0.018 | -1.000 | -0.267 | -1.112 | -0.305 | 1.02% | 1.37 | 41.070 |
| ETH | 4059 | 93.87% | 26.85% | -0.101 | -1.000 | -0.355 | -1.122 | -0.388 | 1.02% | 2.02 | 39.142 |
| combined | 11697 | 94.75% | 26.80% | -0.077 | -1.000 | -0.335 | -1.118 | -0.356 | 0.96% | 1.93 | 112.797 |

OOS (net R): median 1st/2nd half −1.112 / −1.123; mean 1st/2nd half −0.333 / −0.338.

R histogram (gross, resolved, n=11083): `-1`: 8113 · `0–1`: 1505 · `1–2`: 96 · `2–3`: 497 · `≥3`: 872

### ctl-htf-15mstop-1m — control (stop/target at 15m structure)

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | net R 90% LB | median stop % | median hold h | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 290 | 96.90% | 27.40% | 0.018 | -1.000 | -0.267 | -1.227 | -0.397 | 0.42% | 1.38 | 2.797 |
| SOL | 451 | 94.46% | 24.18% | -0.070 | -1.000 | -0.353 | -1.242 | -0.465 | 0.43% | 1.02 | 4.349 |
| ETH | 333 | 91.59% | 26.56% | -0.056 | -1.000 | -0.324 | -1.233 | -0.449 | 0.51% | 1.38 | 3.211 |
| combined | 1074 | 94.23% | 25.79% | -0.042 | -1.000 | -0.320 | -1.236 | -0.389 | 0.44% | 1.02 | 10.357 |

OOS (net R): median 1st/2nd half −1.239 / −1.233; mean 1st/2nd half −0.298 / −0.342.

R histogram (gross, resolved, n=1012): `-1`: 751 · `0–1`: 84 · `1–2`: 3 · `2–3`: 64 · `≥3`: 110

## Findings (numbers only, no recommendation)

- All three rules' median net R is negative in both OOS halves, on every symbol and
  combined — the same asymmetric-tail shape `docs/RETEST_ENTRY_STUDY_2026-09-27.md` found
  for the S3 family: a win rate around 26–28% with a right tail of large winners (e.g.
  `htf-entry-1m` combined: 207 of 1,677 resolved signals, 12.3%, landed ≥3R gross) pulls
  the mean toward zero/positive while the median stays deep negative (all three rules'
  combined net R median sits between −1.12 and −1.24 — i.e. typically the FULL stop is
  hit, consistent with a low base win rate at this stop/target ratio).
- `htf-entry-1m`'s own combined net R mean (−0.183, 90% LB −0.248) and the random-direction
  control's (−0.335, 90% LB −0.356) are both negative, with the live rule's mean and lower
  bound each sitting closer to zero than the control's — the 4h+1D direction gate reads as
  somewhat less negative than an undirected coin flip on this window, though neither
  clears zero and the median read (the more robust statistic at this sample size per
  `docs/VARIANTS_STUDY_2026-09-26.md`'s own reasoning) is close between the two
  (−1.151 vs −1.118).
- The 15m-structure-stop control's combined net R median (−1.236) and mean (−0.320) sit
  between the other two, closer to the random control than to the live rule; its per-symbol
  spread is the tightest of the three (−0.267 to −0.353 mean net R across BTC/SOL/ETH).
- Signal frequency: the live rule fires 17.1 signals/week combined (1,776 over 103.7
  weeks) — far fewer than the random-direction control's 112.8/week (11,697), confirming
  the direction gate materially restricts trigger frequency, as it should by construction
  (only a subset of 1m/5m flags occur while a 4h+1D-agreeing regime is active). The
  15m-stop control fires 10.4/week (1,074) — fewer than the live rule despite sharing the
  same direction/trigger gate, because a qualifying 15m swing structure that also clears
  the ≥2.5R/≥1.0R gates against a smaller 15m impulse is less often available than a 1h one.
- **None of this is a verdict.** The master prompt is explicit that this replay does not
  gate the release either way (`docs/OWNER_DECISIONS_2026-09-27.md` "T-20") — the owner's
  decision to ship live stands regardless of what these numbers show.
