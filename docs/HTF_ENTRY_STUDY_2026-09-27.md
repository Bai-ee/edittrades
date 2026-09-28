# T-20 — HTF-anchored entry replay results

Generated 2026-09-27/28 per `docs/PROMPT_T20_HTF_ENTRY.md` deliverable 4 (worktree
`snapshot_tradingview-htf`, branch `htf-entry`, off `origin/upgrade-signal-engine`).
Numbers only, no recommendation — the owner already decided to ship this rule live in the
same phase (`docs/OWNER_DECISIONS_2026-09-27.md` "T-20"); this replay does not gate that
release.

**Data-window disclosure (read this first):** the master prompt names
`test/fixtures/history/deep2y-2026-09-26` (2024-10-01 → 2026-09-27, ~103.7 weeks) as the
replay fixture. That run was started in this same phase (`node --max-old-space-size=20480
scripts/swing/run.js --history test/fixtures/history/deep2y-2026-09-26 --symbols
BTC,SOL,ETH --rules <id> --out-dir docs/swing`, one process per rule, run in parallel) but
did not finish inside this session's wall-clock budget: this is the **first 1-minute-cadence
rule** ever run through `scripts/swing/run.js` (every prior swing rule signals at 1h/4h/1d
cadence, 60–1,440× fewer `signalAt` calls over the same span), and `detectFlagLifecycle`
per call dominates the cost. A timed run on the smaller `deep60-2026-09-24` fixture
(2026-07-01 → 2026-09-24, ~12.2 weeks, same 3 symbols) needed **1,164,945 ms (~19.4 min) for
one rule alone** — scaling that to the ~8.6× larger 2-year window puts each rule at roughly
2.5–3 hours, and all three were still running after ~2 hours when this doc was written.
**The tables below are the complete, real, correctly-scored `deep60-2026-09-24` replay
(~12.2 weeks) — not the 2-year window.** The three `deep2y-2026-09-26` background
processes were left running (not killed) past the end of this session; see "Resuming the
2-year run" below for the exact commands to pick up their output and regenerate this doc's
tables from it. Every mechanic (rule, scoring, cost model, histogram, bootstrap) is
identical between the two windows — only the sample size and calendar span differ.

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

Run at every closed 1m candle (`tf: '1m'`), 3m skipped in this harness (no native 3m
fixture — the harness's own convention: "3m is derived production-side and not
reconstructed here," same as every prior swing study); the live wiring checks 3m too.

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
  the remainder is `not_filled` (the trigger printed but price never touched the entry
  within the fill window — entry is the trigger candle's own close here, so this is
  normally at/near 100%, matching the "prefilled" convention `re-flag-retest-1h` also
  uses since its entry is likewise the signal candle's own close).
- **Median stop %**: over every fired signal (not just resolved) — `|entry−stop|/entry×100`.
- **Median hold**: hours, over resolved signals only (`outcome.holdCandles / 60`).
- **Signals/week**: `n ÷ weeks` — `12.2143` weeks for `deep60-2026-09-24` (2026-07-01 →
  2026-09-24); the 2-year table (once regenerated) uses `103.7` weeks, the same figure
  `docs/RETEST_ENTRY_STUDY_2026-09-27.md` quotes for the identical `deep2y-2026-09-26`
  fixture.
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

## Results — `deep60-2026-09-24` (~12.2 weeks, 2026-07-01 → 2026-09-24)

### htf-entry-1m — the live rule

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | net R 90% LB | median stop % | median hold h | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 20 | 80% | 12.5% | -0.671 | -1.000 | -0.996 | -1.273 | -1.130 | 0.42% | 1.64 | 1.637 |
| SOL | 89 | 73.03% | 36.92% | 0.250 | -0.285 | -0.019 | -0.556 | -0.265 | 1.02% | 4.45 | 7.287 |
| ETH | 46 | 69.57% | 34.38% | 0.458 | -1.000 | 0.135 | -1.303 | -0.271 | 1.02% | 17.44 | 3.766 |
| combined | 155 | 72.9% | 32.74% | 0.178 | -0.833 | -0.114 | -1.144 | -0.315 | 1.02% | 10.2 | 12.690 |

OOS (net R): median 1st/2nd half −1.150 / −1.057; mean 1st/2nd half −0.560 / +0.325.

R histogram (gross, resolved, n=113): `-1`: 76 · `0–1`: 12 · `1–2`: 0 · `2–3`: 6 · `≥3`: 19

### ctl-htf-random-1m — control (seeded random direction)

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | net R 90% LB | median stop % | median hold h | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 318 | 79.56% | 24.11% | -0.397 | -1.000 | -0.675 | -1.181 | -0.757 | 0.51% | 2.02 | 26.035 |
| SOL | 380 | 70.26% | 25.84% | -0.087 | -1.000 | -0.346 | -1.100 | -0.456 | 0.76% | 1.92 | 31.111 |
| ETH | 388 | 53.87% | 29.67% | 0.011 | -1.000 | -0.269 | -1.072 | -0.400 | 0.75% | 4.43 | 31.766 |
| combined | 1086 | 67.13% | 26.34% | -0.167 | -1.000 | -0.438 | -1.116 | -0.496 | 0.66% | 2.35 | 88.912 |

OOS (net R): median 1st/2nd half −1.163 / −1.082; mean 1st/2nd half −0.541 / −0.336.

R histogram (gross, resolved, n=729): `-1`: 537 · `0–1`: 100 · `1–2`: 11 · `2–3`: 35 · `≥3`: 46

### ctl-htf-15mstop-1m — control (stop/target at 15m structure)

| scope | n | filled % | win % | gross R mean | gross R median | net R mean | net R median | net R 90% LB | median stop % | median hold h | signals/wk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 7 | 85.71% | 0% | -0.586 | -0.626 | -0.920 | -0.959 | -1.173 | 0.42% | 36.18 | 0.573 |
| SOL | 16 | 75% | 8.33% | -0.280 | -1.000 | -0.613 | -1.333 | -1.269 | 0.42% | 0.92 | 1.310 |
| ETH | 8 | 62.5% | 60% | 1.592 | 3.142 | 1.259 | 2.808 | 0.323 | 1.02% | 59.25 | 0.655 |
| combined | 31 | 74.19% | 17.39% | 0.047 | -1.000 | -0.286 | -1.333 | -0.784 | 0.42% | 1.02 | 2.538 |

OOS (net R): median 1st/2nd half −1.333 / −1.333; mean 1st/2nd half −0.392 / −0.189.

R histogram (gross, resolved, n=23): `-1`: 19 · `0–1`: 0 · `1–2`: 0 · `2–3`: 0 · `≥3`: 4

## Findings (numbers only, no recommendation)

- On this ~12.2-week window, `htf-entry-1m` fires far less often than the random-direction
  control (155 vs 1,086 signals) — the 4h+1D direction gate is doing real filtering, not
  passing through everything. `ctl-htf-15mstop-1m` fires far less often still (31 signals):
  that control's stop/target requirement (a confirmed 15m swing structure at all, plus the
  same ≥2.5R/≥1.0R gates against a much smaller 15m impulse) is far more restrictive than a
  1h swing's typically-larger impulse, so most triggers never clear the R:R floor on a 15m
  anchor. `htf-entry-1m`'s own combined net R median (−1.144) and mean (−0.114) are both
  negative on this window; ETH's combined mean is the only positive symbol-level net figure
  (+0.135, on a small 32-resolved sample).
- The random-direction control's net R median (−1.116 combined) is close to
  `htf-entry-1m`'s own (−1.144) on this window — consistent with (not distinguishing
  from) a "no edge from the direction gate specifically, on this sample" read, though the
  sample is 12.2 weeks, not the 2-year window this study is meant to run on.
- All three rules' median net R is negative in both OOS halves on this window (the same
  asymmetric-tail shape `docs/RETEST_ENTRY_STUDY_2026-09-27.md` found for the S3 family:
  a low win rate with a right tail of large winners, e.g. `htf-entry-1m`'s own histogram —
  19 of 113 resolved signals landed ≥3R gross — pulls the mean toward positive while the
  median stays negative).
- The 15m-stop control's ETH row (n=8, 60% win, net median +2.81R) is the one clearly
  positive cell in this table; it is also the smallest sample in the study (8 signals) and
  should not be read as a finding at this size.
- **None of this is a verdict.** The window is ~12.2 weeks, not the 2-year window the
  master prompt specifies, and the master prompt is explicit that this replay does not
  gate the release either way (`docs/OWNER_DECISIONS_2026-09-27.md` "T-20").

## Resuming the 2-year run

The three `deep2y-2026-09-26` background processes (started from
`/Users/bballi/Documents/Repos/snapshot_tradingview-htf`, branch `htf-entry`) were:

```
node --max-old-space-size=20480 scripts/swing/run.js --history test/fixtures/history/deep2y-2026-09-26 --symbols BTC,SOL,ETH --rules htf-entry-1m --out-dir docs/swing --out-md <scratch>/htf-main.md
node --max-old-space-size=20480 scripts/swing/run.js --history test/fixtures/history/deep2y-2026-09-26 --symbols BTC,SOL,ETH --rules ctl-htf-random-1m --out-dir docs/swing --out-md <scratch>/htf-random.md
node --max-old-space-size=20480 scripts/swing/run.js --history test/fixtures/history/deep2y-2026-09-26 --symbols BTC,SOL,ETH --rules ctl-htf-15mstop-1m --out-dir docs/swing --out-md <scratch>/htf-15mstop.md
```

Each writes `docs/swing/<rule-id>.json` on completion (the CLI's own `--out-md` markdown
table is not what this doc uses — the tables above come from `scripts/swing/analyze-htf.js`
against that JSON directly). Once all three `docs/swing/{htf-entry-1m,ctl-htf-random-1m,
ctl-htf-15mstop-1m}.json` exist:

```
node -e "
import('./scripts/swing/analyze-htf.js').then((m) => {
  for (const id of ['htf-entry-1m','ctl-htf-random-1m','ctl-htf-15mstop-1m']) {
    console.log(id, JSON.stringify(m.analyzeRule(id), null, 2));
  }
});
"
```

produces the same shape of numbers as this doc's tables (default `weeks` is already
`103.7`, correct for `deep2y-2026-09-26`) — replace this doc's three tables and the
"Findings" section with the 2-year numbers and remove the data-window disclosure at the
top once that is done. Expect roughly 2.5–3 hours per rule (all three can run in parallel;
14 CPU cores / 36 GB RAM handled three concurrent processes at ~2–3 GB RSS / 120–150% CPU
each without contention in this session).
