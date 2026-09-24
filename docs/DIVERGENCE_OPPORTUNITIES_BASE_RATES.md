# Divergence opportunities — measured base rates (T5 P0)

**Status: PROVISIONAL.** Measured on development data only (`scripts/replay-early-entry.js`,
`scripts/replay-paths.js`, `scripts/tracker/flag-paths.js`); no production file reads it.
Definitions: `docs/PLAN_DIVERGENCE_OPPORTUNITIES.md`. Nothing here changes a threshold; GO IN,
minRR, the 3% scalp stop guard, `flagTradePlan` and the recommendation class logic are
unchanged and untouched.

Last updated: 2026-09-24.

## Data

| Dataset | Span | Flags labelled |
| --- | --- | --- |
| `test/fixtures/history/deep-2026-09-24/` (same capture T4 P0 used) | 2026-09-09 → 2026-09-24, ~15 days, BTC/SOL/ETH | **10,997** (BTC 3,716, SOL 3,571, ETH 3,710 — identical counts to `docs/FLAG_PATHS_BASE_RATES.md`, confirming the new `featuresAt` fields are additive and did not change candidate detection or the existing path labels) |

`test/fixtures/history/deep60-2026-09-24/` (60-day capture, S2) was still mid-backfill when
this report was written (only `BTC_1m.backfill.json` + `capture.log`/`capture.start`
present, no `manifest.json`, SOL/ETH not started). Not run here — see "Reproduce" below for
the exact commands once it completes.

## New features (T5 P0 item 1, additive — every T4 feature/bucket is unchanged)

Computed by `featuresAt` (`scripts/tracker/flag-paths.js`) from ctx built in
`scripts/replay-paths.js`'s `buildRow`, reading the same production payload it already
builds (`includeBias`/`includeModel` now both on):

- **`divergence`** (`agrees` / `conflicts` / `none` / `unknown`) — Stoch RSI divergence on
  the candidate's own timeframe (`lib/modelEvidence.js`'s `buildDivergenceEvidence`), in the
  flag's direction, **fresh only**: a stale hit (`strength` 0, beyond
  `divergenceMaxAgeCandles`) reads as `none`, the same rule that module's own confluence
  count uses.
- **`atLevel`** (`yes` / `no` / `unknown`) — the flag's invalidation sits within 0.5 ATR of a
  support zone (long) / resistance zone (short), read from `geometryContext` across every
  timeframe. An empty/no-zone read is a genuine `no`, not `unknown`.
- **`sweepReclaim`** (`yes` / `no` / `unknown`) — within the last 5 candidate-tf candles as
  of the tightening point, a wick beyond the invalidation level with that same candle's
  close back on the flag side.
- **`counterTrend`** (`yes` / `no` / `unknown`) — the 4h bias (`lib/biasMatrix.js`) leans
  against the flag's own direction. A measured `neutral` 4h is a known "no lean" (`no`), not
  `unknown`.

Two additive row fields (not `features`, consumed only by `replay-early-entry.js`):
`tighteningClose` (the tightening candle's own close — the early-entry price) and `tp1Cap`
(the TP1 both entry simulations share: the nearest opposing zone edge strictly ahead of
`breakoutLevel` and short of `measuredTarget`, else `measuredTarget` — a price-returning
equivalent of `lib/flagTradePlan.js`'s private `nearestRoomAhead`, written in
`scripts/replay-paths.js` since `lib/` is not touched by this thread).

## Entry simulations (T5 P0 item 2)

Both share stop = `invalidation` and TP1 = `tp1Cap` (else `measuredTarget`); only the entry
price and walk start differ. 24h 1m walk, no lookahead, prefilled (`walkShadow`).

- **EARLY** — entry = `tighteningClose`, walked from the tightening point. Every row with a
  valid direction/entry/stop/target is simulated, regardless of what its labelled path
  turned out to be (a fail_first row is a real early-entry loss).
- **RETEST** (comparison) — entry = `breakoutLevel`, walked from `retestAt`, published only
  when a retest-hold touch actually occurred (same rule `scripts/replay-breakout-entry.js`'s
  `retestEntryFor` uses).

No minRR/max-stop-% gate is applied (unlike `flagTradePlan`/the T4 P4 shadow entry) — this is
a measure-only comparison across every structurally valid setup, not a candidate for what
production would publish.

### Headline: overall

| Entry | n | win rate | gross expectancy | net expectancy (after fees) | max losing streak |
| --- | --- | --- | --- | --- | --- |
| EARLY (pre-confirmation) | 10,291 | 25.52% | **+0.534R** | **−0.645R** | 54 |
| RETEST (confirmed, comparison) | 3,344 | 55.22% | +0.261R | −0.320R | 17 |
| baseline path labels (all flags) | 10,997 | — | fail_first 47.93%, runner 15.28%, retest_go 16.08%, false_break 11.96%, chop 8.76% | — | — |

**Early entry beats confirmed entry on gross R (+0.53R vs +0.26R) — entering before
confirmation, closer to the flag's own invalidation, genuinely earns a bigger reward per unit
of price risk, exactly the mentor's intuition. But net of fees it is the worse of the two: an
early entry's stop (tightening close → invalidation) is a *smaller price distance* than a
confirmed entry's (breakoutLevel → invalidation), and the round-trip fee (`risk.feeBps` +
`risk.slippageBps`, 20bps total at current config) is a fixed fraction of entry price — so it
eats a much larger share of a tight early stop's R. At current fee/slippage assumptions, no
early-entry bucket measured below is net-positive.**

### Does divergence-at-level beat the base rate on fail_first?

Modestly, yes — each feature on its own:

| Feature | fail_first (feature value) | fail_first (baseline 47.93%) |
| --- | --- | --- |
| `divergence=agrees` (n=2,992) | 46.06% | −1.9pp |
| `divergence=conflicts` (n=3,291) | 48.40% | +0.5pp |
| `divergence=none` (n=4,714) | 48.79% | +0.9pp |
| `atLevel=yes` (n=5,661) | 45.50% | −2.4pp |
| `atLevel=no` (n=5,336) | 50.51% | +2.6pp |
| `sweepReclaim`/`counterTrend` | 47.35–48.51% | ≈ baseline (no meaningful effect on fail_first alone) |

Stacking `divergence=agrees` + `atLevel=yes` (n=588–894 depending on the other two features)
pushes fail_first down further, to 43.5–43.6%, and the same pair with `counterTrend=yes`
(n=306) reads 37.25% — the single lowest fail_first rate of any calibrated combo measured.
That last number is the smallest bucket among the low-fail_first group and should be read
cautiously (see Caveats); it is not confirmed by a matching net-expectancy edge (below).

### Does divergence-at-level beat the base rate on early-entry net expectancy?

**No.** Every calibrated (n ≥ 100) combo's EARLY-entry net expectancy is negative — including
every `divergence=agrees` × `atLevel=yes` combination. The best early-entry combo measured is
`divergence=agrees|atLevel=no|sweepReclaim=no|counterTrend=no` at **−0.327R** (n=399), still a
losing bucket, just the least-losing one. The tight-stop/fee-erosion effect above dominates
every feature combination at the current 15-day n.

### Which combo qualifies for an OPPORTUNITY tier?

**Qualification (defined for this report): n ≥ 100, net expectancy > 0, and better than the
all-flags EARLY-entry net expectancy (−0.645R).**

**One combo qualifies — on the RETEST entry, not the early entry:**

> `divergence=agrees | atLevel=no | sweepReclaim=no | counterTrend=no`
> n=149, win rate 62.77%, gross expectancy +0.871R, **net expectancy +0.202R**, max losing
> streak 7. (Row-level path mix for the same 432-row combo bucket: fail_first 46.99%, runner
> 12.27% — essentially baseline; the edge is not a fail_first reduction, it shows up only in
> the confirmed-retest R math.)

No EARLY-entry combo qualifies (best is −0.327R, still negative). This is a genuine, if
narrow, finding worth being direct about: **the data does not support an early,
pre-confirmation "opportunity" tier at current fee assumptions** — the mentor's intuition
(enter before confirmation, closer to support) is directionally correct on gross R, but fees
turn every measured early-entry bucket net-negative. The one bucket that clears the bar is a
refinement of the *existing* confirmed-retest flow (skip it when `atLevel=yes` or
`counterTrend=yes`), not a new pre-confirmation signal. It also requires `atLevel=no` —
the opposite of "at a level" from the plan's own motivating framing — so "divergence agrees,
away from a level, with-trend" is the qualifying read, not "divergence at a level."

### Full combo table (all 24 calibrated combos, n ≥ 100 on rows; sorted by row count)

| combo (div / atLevel / sweepReclaim / counterTrend) | rows n | fail_first% | runner% | early n | early net R | retest n | retest net R |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none/yes/no/no | 805 | 45.71 | 9.19 | 777 | −0.604 | 300 | −0.329 |
| none/no/yes/no | 772 | 52.98 | 21.24 | 691 | −0.739 | 159 | −0.493 |
| none/yes/yes/no | 716 | 47.49 | 18.16 | 683 | −0.669 | 193 | −0.341 |
| none/no/no/no | 670 | 51.04 | 12.39 | 631 | −0.575 | 201 | −0.126 |
| conflicts/yes/no/no | 596 | 43.62 | 12.42 | 572 | −0.559 | 227 | −0.251 |
| agrees/yes/no/no | 588 | 43.54 | 9.18 | 577 | −0.542 | 225 | −0.182 |
| conflicts/yes/yes/no | 522 | 45.79 | 21.26 | 494 | −0.647 | 143 | −0.291 |
| conflicts/no/yes/no | 532 | 50.00 | 19.36 | 484 | −0.672 | 131 | −0.377 |
| agrees/no/yes/no | 469 | 46.91 | 24.09 | 434 | −0.725 | 110 | −0.450 |
| none/yes/yes/yes | 451 | 46.12 | 15.96 | 429 | −0.712 | 145 | −0.458 |
| none/no/yes/yes | 477 | 48.22 | 22.43 | 421 | −0.722 | 116 | −0.475 |
| none/yes/no/yes | 434 | 46.31 | 11.52 | 412 | −0.593 | 152 | −0.302 |
| **agrees/no/no/no** | 432 | 46.99 | 12.27 | 399 | −0.327 | **149** | **+0.202** |
| agrees/yes/yes/no | 397 | 44.84 | 20.15 | 376 | −0.656 | 118 | −0.338 |
| none/no/no/yes | 389 | 51.93 | 12.60 | 370 | −0.722 | 115 | −0.442 |
| conflicts/no/no/no | 394 | 53.05 | 9.14 | 346 | −0.646 | 123 | −0.294 |
| conflicts/no/yes/yes | 350 | 50.57 | 18.57 | 324 | −0.745 | 95 | −0.493 (uncalibrated) |
| agrees/yes/no/yes | 306 | 37.25 | 9.15 | 298 | −0.565 | 136 | −0.361 |
| conflicts/yes/no/yes | 309 | 48.22 | 9.39 | 295 | −0.681 | 110 | −0.343 |
| conflicts/yes/yes/yes | 302 | 46.69 | 15.89 | 282 | −0.727 | 91 | −0.405 (uncalibrated) |
| agrees/no/yes/yes | 304 | 49.67 | 20.07 | 277 | −0.744 | 74 | −0.471 (uncalibrated) |
| conflicts/no/no/yes | 286 | 53.15 | 13.29 | 256 | −0.735 | 88 | −0.583 (uncalibrated) |
| agrees/no/no/yes | 261 | 51.34 | 7.66 | 245 | −0.705 | 80 | −0.294 (uncalibrated) |
| agrees/yes/yes/yes | 235 | 51.91 | 16.17 | 218 | −0.675 | 63 | −0.279 (uncalibrated) |

Full JSON (every table: overall, by-feature, by-combo, both entry types):
`scripts/replay-early-entry.js --json`; a copy from this run is not checked in (dev-only
output).

### Counter-trend effect

Consistent and one-directional — `counterTrend=yes` is worse than `counterTrend=no` on both
entry types, on every measure:

| Entry | counterTrend | n | win rate | net expectancy |
| --- | --- | --- | --- | --- |
| EARLY | no | 6,464 | 26.55% | −0.618R |
| EARLY | yes | 3,827 | 23.79% | −0.693R |
| RETEST | no | 2,079 | 57.10% | −0.266R |
| RETEST | yes | 1,265 | 52.15% | −0.408R |

A 4h-counter-trend flag costs roughly 0.08–0.14R of net expectancy on both entry types,
across every measured window. This matches the existing `ct:4h` qualifier reason and
`flagRecommendation`'s `opposes` field — divergence does not rescue a counter-trend setup;
the qualifying OPPORTUNITY combo above explicitly requires `counterTrend=no`.

### The mentor's BTC case (2026-09-24, 3m long)

**Not found in this capture.** Searched every BTC row (both directions, all timeframes) for
`breakoutLevel` within ±$100 of $84,113.50 and, separately, `invalidation` within ±$100 of
$83,709.90 — no 3m long row matches both simultaneously. The nearest 3m-long candidates near
this price zone are from 2026-09-21 (invalidation ≈ $83,660–83,660, a materially wider R than
described) and 2026-09-23/24 candidates near $84,100–84,200 pair with invalidations only
$50–150 away (a much tighter R), not $83,709.90. $84,113.50 itself does appear as
`invalidation` (not `breakoutLevel`) on an unrelated 1m short row on 2026-09-24, and as
`breakoutLevel` on two 3m/5m *short* rows on 2026-09-23 — none of these are the mentor's long
setup. Either the mentor's exact tightening point falls outside this specific capture's build
cadence/candle composition, or it is a live observation not yet reflected in a saved history
file — it cannot be scored against this dataset as things stand.

## Caveats

- Same caveats as `docs/FLAG_PATHS_BASE_RATES.md`: one 15-day window, one top-down regime,
  three correlated symbols, not 10,997 independent trials.
- No minRR/max-stop-% gate on either entry simulation (by design — a measure-only
  comparison), so `n` here is larger than what `flagTradePlan`/the T4 P4 shadow entry would
  actually have published.
- Net expectancy uses `netRiskReward`'s fixed per-trial figure on a win and a flat −1R on a
  loss (round-trip fees are in fact paid on losses too, not only wins) — the same
  documented, directionally-correct-not-penny-exact convention
  `scripts/replay-breakout-entry.js`'s `stats()` uses.
- The 24-combo table's smaller buckets (n < ~300) should be read as noisy; several
  "uncalibrated" retest cells (n < 100) are shown for completeness, not as evidence.
- Only one combo clears the OPPORTUNITY bar at n=149 — a single 15-day window's worth of
  data for a four-way split. It should be treated as a lead to re-test on the 60-day capture
  (S2), not a result to act on.

## Reproduce

```
# labelled rows (already run for this report; rerun after any featuresAt/replay-paths.js change)
for s in BTC SOL ETH; do node scripts/replay-paths.js --history test/fixtures/history/deep-2026-09-24 --symbols $s --out /tmp/deep-$s.jsonl & done; wait
cat /tmp/deep-BTC.jsonl /tmp/deep-SOL.jsonl /tmp/deep-ETH.jsonl > /tmp/deep-all.jsonl

# early/retest entry simulation + report
node scripts/replay-early-entry.js --rows /tmp/deep-all.jsonl --history test/fixtures/history/deep-2026-09-24 --json /tmp/deep-early-entry.report.json

# once test/fixtures/history/deep60-2026-09-24/manifest.json exists and is complete (S2, another agent):
for s in BTC SOL ETH; do node scripts/replay-paths.js --history test/fixtures/history/deep60-2026-09-24 --symbols $s --out /tmp/deep60-$s.jsonl & done; wait
cat /tmp/deep60-BTC.jsonl /tmp/deep60-SOL.jsonl /tmp/deep60-ETH.jsonl > /tmp/deep60-all.jsonl
node scripts/replay-early-entry.js --rows /tmp/deep60-all.jsonl --history test/fixtures/history/deep60-2026-09-24 --json /tmp/deep60-early-entry.report.json
```
