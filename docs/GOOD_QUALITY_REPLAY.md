# GOOD-quality replay — T6 phase 0

Status: **done, research only, no deploy.** Waiting on the owner's variant pick (D1),
`docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md`.

## Method

- **Runner:** `scripts/replay-rules.js` (`npm run replay:rules -- --variant <id> --history
  <dir>`, tested by `test:rules`, 25 tests). One process scores one variant: it applies
  the variant's config through `config/engine.js`'s new `setConfigOverride` (deep-merge
  onto the on-disk config, a live ES-module binding — every importer of `ENGINE_CONFIG`
  sees it with no code change), then replays the production pipeline
  (`scripts/replay.js`'s `buildAt`/`replaySymbol`, no lookahead) one close at a time.
- **Data:** `test/fixtures/history/deep-2026-09-24/` — BTC/SOL/ETH, `manifest.json` span
  2026-09-09T06:22Z → 2026-09-24T06:21Z (15 days of 1m/3m/5m; 15m/1h/4h/1d reach further
  back natively, so the pipeline's own `replay.minComputeCandles` warm-up finishes by
  ~2026-09-11, not day 15 — the first ~2 days of the nominal 15-day span could not score
  a plan on any variant; `coverage`/`goodPerDay` below is a hair conservative because of
  it). `test/fixtures/history/deep60-2026-09-24/` has no `manifest.json` yet (capture
  in progress) — per the plan, phase 0 ran on the 15-day set only.
- **Clock:** every 1m close (`--step 1`) — the 15-day span easily affords it
  (~15.7 ms/close measured; 12.7 ms/close on an earlier timing probe), so nothing here
  used the coarser 5-minute fallback the plan allows.
- **Scoring:** a plan/trial's **first** `ready` close per `(symbol, candidateId)` is
  walked with the tracker's own `walkOutcome` (`scripts/tracker/walk-outcome.js`),
  `prefilled: true` — the same `ready_prefilled` convention `scripts/tracker/score.js`
  uses for a real captured GOOD call (the breakout-retest-hold sequence already happened
  on a closed candle, so scoring starts filled, not searching for a touch) — for 24h.
  Gross R is the walk's own R (win) or −1 (loss); **net R is the realised net R on that
  outcome** (`scripts/tracker/costs.js` `netR`, 0.20% round-trip cost) — not the plan's
  forward-looking `netRR` field, a different ratio (both are on every scored row). Cost
  sensitivity columns are reported alongside (next bullet), information only.
- **Net gate:** shipped as real code, off by default — `flagPlan.minNetRR` (null =
  off), checked in `lib/flagTradePlan.js` right after the existing gross `minRR` gate;
  below the floor the plan is `rejected`/`net_rr_below_min`, levels kept. Config version
  bumped 2026.09.24-1 → **2026.09.24-2**. `test:flagplan` gained 4 mirrored tests for it
  (47 total); `test:config` gained 4 for the override hook itself (18 total). With the
  default `null`, every existing suite passes unchanged — confirmed by the full test
  gate below.
- **Cost sensitivity (decision D3, recorded 2026-09-24 from Jupiter Perps' published fee
  schedule):** the shipped cost stays 0.20% round trip (`risk.feeBps`/`slippageBps`,
  unchanged); every variant also reports two information-only columns — **0.14%**
  (collateral matches the position, holds under 1h) and **0.34%** (a long funded with
  USDC, paying an extra swap in and out).
- **Out-of-sample rule** (as specified): a variant passes only if net expectancy > 0 in
  **both** halves and **n ≥ 20** scored GOOD calls. Read `n` as the *overall* count (not
  per half) — the plan's wording is ambiguous and n ≥ 20 per half is not reachable on 15
  days at this base rate; this reading is stated so the owner can override it.
- **Raw outputs:** `var/replay-rules/<variant>.{calls.jsonl,summary.json,log}`
  (gitignored, regenerate with `npm run replay:rules`).

## Variant comparison (15 days, BTC+SOL+ETH, all closes)

| Variant | Change | n | resolved | win% | grossExp R | **netExp R (0.20%)** | 0.14% sens | 0.34% sens | maxLoseStreak | medianStop% | GOOD/day | days w/ ≥1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V0 | baseline | 105 | 99 | 26.3% | 0.258 | **−2.309** | −1.539 | −4.107 | 16 | 0.115% | 7.00 | 80% |
| V1a | net gate 1.0 | 46 | 40 | 30.0% | 0.492 | **−0.382** | −0.120 | −0.994 | 12 | 0.280% | 3.07 | 46.7% |
| V1b | net gate 1.5 | 29 | 23 | 39.1% | 0.785 | **+0.290** | +0.439 | −0.056 | 5 | 0.363% | 1.93 | 40.0% |
| **V1c** | **net gate 2.0** | 17 | 11 | 54.5% | 1.163 | **+0.842** | +0.938 | **+0.617** | 2 | 0.596% | 1.13 | 26.7% |
| V2 | +15m/1h flag TFs | 113 | 103 | 25.2% | 0.205 | **−2.194** | −1.474 | −3.872 | 17 | 0.132% | 7.53 | 80% |
| V3a | V2 + net gate 1.5 | 37 | 27 | 33.3% | 0.507 | **+0.082** | +0.210 | −0.216 | 6 | 0.404% | 2.47 | 53.3% |
| V3b | V2 + net gate 2.0 | 24 | 14 | 42.9% | 0.699 | **+0.440** | +0.518 | +0.260 | 4 | 0.710% | 1.60 | 33.3% |
| V4 (research) | V3a, gross minRR 2.5 | 47 | 38 | 34.2% | 0.486 | **+0.075** | +0.198 | −0.213 | 7 | 0.464% | 3.13 | 53.3% |
| V5 (research) | 15m/1h structure stop/target, swing | 4 | 4 | 0% | −1.000 | **−1.818** | −1.573 | −2.391 | 4 | 0.250% | 0.27 | 13.3% |
| V6 | V1b + ATR(15m) floor | 175 | 172 | 30.2% | 0.206 | **−0.225** | −0.096 | −0.527 | 17 | 0.428% | 11.67 | 86.7% |
| V7 (research) | reversal scout | 0 | — | — | — | — | — | — | — | — | 0 | 0% |

**None of the ten scoreable variants formally passes** the phase-0 rule (net > 0 in both
halves, n ≥ 20). V1c is the closest miss — see OOS table. Under the pessimistic 0.34%
cost (a USDC-funded long, D3), only V1c and V3b stay net-positive (+0.617 and +0.260);
V1b flips negative (−0.056) despite being comfortably positive at 0.20%/0.14%. V1c keeps
the widest margin of any variant at every cost assumption tried.

## Out-of-sample halves (first 2/3 = days 1–10, last 1/3 = days 11–15; boundary
2026-09-19T06:21Z)

| Variant | first n | first netExp R | second n | second netExp R | passes? |
| --- | --- | --- | --- | --- | --- |
| V0 | 46 | −2.608 | 59 | −2.077 | no |
| V1a | 19 | −0.053 | 27 | −0.614 | no |
| V1b | 14 | +0.736 | 15 | −0.126 | no (second half negative) |
| **V1c** | 10 | **+1.284** | 7 | **+0.211** | **no — only on n (17 < 20); both halves ARE positive** |
| V2 | 48 | −2.533 | 65 | −1.943 | no |
| V3a | 16 | +0.541 | 21 | −0.268 | no (second half negative, despite n=37 ≥ 20) |
| V3b | 11 | +1.167 | 13 | −0.174 | no (second half negative, despite n=24 ≥ 20) |
| V4 | 18 | +0.706 | 29 | −0.317 | no |
| V5 | 2 | −1.818 | 2 | −1.818 | no (n far too thin) |
| V6 | 102 | +0.051 | 73 | −0.611 | no |
| V7 | 0 | — | 0 | — | no (n=0) |

A pattern worth naming: **every** variant's second half (the most recent 5 days) is
weaker than its first half, and for every variant except V1c it flips negative. n=17–37
over 5–15 days is a thin sample for a regime-stability claim; this could be a real
recent-market shift or just noise at this n. The 60-day set (once captured) is the
actual test of this.

## Per-timeframe (the two net-gate-only leaders)

| Timeframe | V1b n | V1b netExp R | V1c n | V1c netExp R |
| --- | --- | --- | --- | --- |
| 1m | 10 | +0.039 | 5 | +0.929 |
| 3m | 12 | **+0.974** | 7 | **+1.431** |
| 5m | 7 | −0.524 | 5 | −0.070 |

3m is the strongest timeframe at both net-gate thresholds; 1m is roughly breakeven-to-
positive; 5m is the weak leg in both. 15m/1h (V2/V3a/V3b only) never turned positive at
any net threshold in this window: 15m netExp ranged −0.42 to −0.59, 1h −1.23 (n=1,
uninformative). **Widening flag.timeframes diluted rather than helped**: at the same net
floor, V3a (with 15m/1h) scored worse than V1b (without) — +0.082R vs +0.290R, 33.3% vs
39.1% win rate — and V3b scored worse than V1c — +0.440R vs +0.842R, 42.9% vs 54.5% win
rate. The extra volume came entirely from 15m/1h calls that were themselves unprofitable.

## Per-symbol / per-direction (V1c, the recommended variant)

| Symbol | n | netExp R | | Direction | n | netExp R |
| --- | --- | --- | --- | --- | --- | --- |
| SOL | 10 | +1.284 | | long | 12 | +1.642 |
| BTC | 4 | +0.860 | | short | 5 | −1.079 |
| ETH | 3 | −0.655 | | | | |

Short calls are net-negative in every net-gated variant (V1a −1.38, V1b −1.42, V1c
−1.08, V3a −1.29, V3b −0.90) while long stays net-positive in all of them. n per side is
small (5–16), so this is a lean to flag for the 60-day recheck, not a rule to ship.

## Payload size and build time, V2/V3 vs V0

Sampled every 30th close's **full (non-compact) local payload** from `buildAt` (not the
production compact default the API actually serves — no compact measurement was run in
phase 0; this is a same-methodology relative comparison, not the Phase-1 byte-cap
number).

| Variant | avg payload bytes | Δ vs V0 | ms/close |
| --- | --- | --- | --- |
| V0 | 26,508 B | — | 15.723 |
| V2 | 28,334 B | +1,826 B (+6.9%) | 15.703 |
| V3a | 28,331 B | +1,823 B (+6.9%) | 15.716 |
| V3b | 28,331 B | +1,823 B (+6.9%) | 15.761 |

Build time is unaffected (differences are inside run-to-run noise); the byte cost is the
15m/1h `candidateSetups` entries becoming eligible. +6.9% against the current 80,500 B
Phase-1 ceiling is a modest, not a blocking, cost — informational only, since V2/V3
aren't the recommendation here.

## V7 verdict — FAILED_FLAG_REVERSAL scout

**0 scored trials over 15 days × 3 symbols. Not net-positive, not net-negative — no
data.** Diagnosed, not just observed: a 3-day BTC-only debug pass found `invalidation_close`
failures are common (126 distinct failed tracks in 3 days for BTC alone), and an
opposing-zone target (`tp1Ahead`, the same helper V5 uses) was reachable in ~40% of
those trials. The blocker is the **gross R:R floor**: stop-beyond-the-reclaim-extreme is
frequently *wide* relative to the *distance to the next opposing zone or the flag's own
pole height*, so the construction almost never reaches 3R gross (151/178 raw attempts
failed on gross RR alone in the same debug pass). This held after fixing the target to
prefer a real zone over the pole-height fallback — the zone, when found, still usually
sits inside 3x the reclaim-extreme stop.

This is a real finding about the *simple* construction tried here, not a verdict on
reversal scouts in general: **per D4, scouts stay scout/watch-only regardless** (never
GO IN without net-positive n ≥ 100 in both halves *and* owner approval), so nothing here
changes shipped behavior either way. If Phase 2 builds `lib/reversalScout.js` for real,
it should not inherit the shared 3R gross floor unmodified — either place the stop
tighter (nearer the immediate reclaim wick, not the full lookback window's extreme) or
accept a lower gross floor for scout-only, never-executed research, and recheck on the
60-day set once it exists.

## Recommendation

**V1c (net gate 2.0) for D1**, with an explicit caveat: it does not formally pass phase
0's own bar (n=17, three short of 20) — see below for why it's still the pick, and V1b
as the fallback if the owner weights call volume over per-call quality.

Reasons:
- **Best net expectancy of any variant** (+0.842R/call, next best +0.440R) and the
  **only variant where both OOS halves are individually positive** (+1.284 / +0.211) —
  every other variant, including every one that cleared n ≥ 20, flips negative in the
  second half.
- **Directly fixes the diagnosed root cause.** Section 1a's problem was stops too tight
  to pay round-trip costs (the real BTC GOOD call: 0.066% stop, −4.0R net on a loss).
  V1c's median stop is 0.596% — 5x V0's 0.115% — pushing cost/risk from ≈1.74 (V0) down
  to ≈0.34, comfortably inside a payable range.
- **Cleanest risk profile:** highest win rate (54.5%), shortest max losing streak (2
  vs. 4–17 everywhere else).
- **Only variant that survives the pessimistic cost case.** At the 0.34% sensitivity
  (D3's USDC-funded-long estimate), V1c is the strongest positive (+0.617R); V1b flips
  negative (−0.056R) at that same assumption despite being solidly positive at the
  shipped 0.20% cost.
- **The shortfall is close, not structural.** 3 calls short of n=20 in 15 days
  (≈1.1/day); the Phase 1 window restart (D2, already approved) keeps accumulating live
  data against the same rule, so the n gap closes in ~3 more days of live calls, not
  months.
- **V2/V3's wider flag.timeframes should NOT ship alongside it** — at every matched net
  threshold, adding 15m/1h diluted net expectancy and win rate rather than improving
  either; keep `flag.timeframes` at `1m/3m/5m` for Phase 1.

**If the owner weights call volume over the OOS shortfall:** V1b (net gate 1.5) is the
alternative — n=29 (clears 20), still net-positive overall (+0.290R), 1.93 calls/day vs
V1c's 1.13, at the cost of a negative second OOS half (−0.126R) and a materially worse
risk profile (max losing streak 5 vs 2, win rate 39.1% vs 54.5%).

**Not recommended:** V0/V1a (net gate off/too low — still net-negative or barely so),
V2/V3a/V3b (15m/1h dilutes), V4 (touches the gross-minRR hard rule, needs an explicit
separate owner decision even to consider, and its net edge, +0.075R, is the thinnest of
every positive variant), V5 (n=4, structurally too thin to read), V6 (ATR floor
manufactures volume — 175 calls, 11.67/day — without fixing quality: net expectancy
stays negative, −0.225R, because gross RR is forced to exactly 3 by construction rather
than earned from real structure).

## Caveats

- n=11–47 per variant on a 15-day window is thin by the plan's own admission (risk
  section: "15 days is about 360 1h candles"). Every number above should be re-run on
  the 60-day set once `deep60-2026-09-24/manifest.json` exists (Phase 4).
- The net-R convention scores the plan's **own published stop/tp1** walked forward; it
  does not model partial fills, slippage beyond the configured bps, or a chase/runner
  path different from TP1-or-stop.
- Payload-size comparison used the full (non-compact) local payload, not the production
  compact default; Phase 1 needs its own compact-mode measurement against the 80,500 B
  cap.
- Short-side weakness (every net-gated variant) is based on n=5–16 per variant — a lean,
  not a rule.

## Step B — frequency study (T6 completion plan, `docs/PLAN_T6_COMPLETION_V2.md` "B1")

Owner goal: "Opportunities visible more than once a day, GOOD calls as often as the
rules honestly allow." Re-run on the same 15-day/3-symbol set, **after** Step A's fixes
(the correctness fixes in particular - see the headline finding below), with two new
frequency columns per `scripts/replay-rules.js`'s `buildFrequencyMetrics`:
- **ready/hr, conditional/hr** - raw per-close counts (not deduped by candidateId): how
  often the owner's chat would literally see `flagTradePlan.status = ready`, or
  `conditional`/`awaiting_retest` with gross R:R already ≥ 3 (a near-miss, waiting only
  on the retest candle). A candidate that stays `ready` for many consecutive closes
  counts once per close here, unlike the GOOD-call table above (first-ready only).
- **GOOD/hr** - the same deduped first-ready count as everywhere else in this doc,
  expressed per hour instead of per day.

### Headline finding: Step A's A3 fix (retest-hold vs. the stop) already fixed most of
### what the net gate was for

V0 (baseline, gross-only gate, no net gate) re-run after Step A now scores **n=17,
netExp +0.84R** - not the −2.31R this same variant scored in Phase 0. The lowest
`plannedNetRR` among all 17 calls is **2.062** - every single one already clears the
2.0 floor V1c enforces. V0's and V1c's raw output files are now **byte-for-byte
identical** (confirmed via `md5sum` and a line diff): the net gate rejects nothing on
this dataset anymore, because A3 (a retest candle that wicks through the stop no longer
counts as a hold) already eliminates the thin/wicked-stop false-ready plans that used to
manufacture GOOD calls with sub-1 net R:R. The original BTC 0.066% incident section 1a
is built on is exactly this failure mode - A3 fixes it at the source, not just at the
gate.

This does not mean the net gate is wrong to have shipped (it is a correct, cheap
backstop - if a future market regime ever produces a thin-stop ready plan again, A3
alone might not catch every case A2/net-gate style rejection would), but on **this**
dataset it is currently non-binding. Worth re-checking on the 60-day set once it exists
(Phase 4) rather than assumed to generalize from 15 days.

### Variant comparison (15 days, BTC+SOL+ETH, all closes, post-Step-A)

`dir-cost` = D-cost's answered column (`docs/OWNER_DECISIONS_2026-09-24.md`): positions
are funded from USDC/USDT, so a long pays the 0.34% swap-in/out rate and a short pays
0.14%, per call (`netR_sensDir`, `scripts/replay-rules.js`), not a flat sensitivity band.

| Variant | Change | n | netExp R | 0.14% sens | 0.34% sens | **dir-cost (D-cost)** | ready/hr | conditional/hr | conditional/day | GOOD/hr | payload avg B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V-A (=V0) | baseline | 17 | +0.842 | +0.938 | +0.617 | +0.758 | 0.261 | 0.133 | 3.19 | 0.047 | 25,985 |
| V1c | net gate 2.0 (shipped) | 17 | +0.842 | +0.938 | +0.617 | +0.758 | 0.261 | 0.133 | 3.19 | 0.047 | 25,985 |
| V-D | retest tolerance 0.2 ATR | 17 | +0.842 | +0.938 | +0.617 | +0.758 | 0.275 | 0.119 | 2.86 | 0.047 | 25,985 |
| **V-C (=V2)** | **+15m/1h flag timeframes** | **25** | +0.532 | +0.610 | +0.349 | +0.444 | **1.053** | **1.675** | **40.2** | **0.069** | 27,494 |
| **V-B (research)** | **gross minRR 2.5 [owner rule change]** | 18 | **+1.102** | +1.199 | +0.876 | **+1.010** | 0.281 | 0.128 | 3.07 | 0.050 | 25,980 |

D-variant's stated floor (≥3 conditional/day combined) is already cleared by **every**
variant tried, including baseline - V-C's +15m/1h widening was never needed to reach it.
That leaves a straight best-expectancy pick under the answered dir-cost column: **V-B
(+1.010R dir-cost) > V-A/V1c/V-D (+0.758R) > V-C (+0.444R)**. V-B ranks highest on
every cost column tried (0.14%/0.34%/dir-cost), not just gross. **V-B is not yet
shippable on this ranking alone** - it lowers the shipped 3R gross floor, a hard rule
the completion plan does not change without a separate, explicit owner sign-off (see
`docs/OWNER_DECISIONS_2026-09-24.md` D-variant note). V-C is not recommended: it is the
weakest variant on every cost column and the only one with a negative OOS second half,
and the frequency floor it exists to clear is already met without it.

No variant passes the phase-0 OOS rule (net > 0 in both halves) - every variant's second
half is +0.21R except V-C's, which is negative. n=17-18 (25 for V-C) is still thin.

### Owner decisions (B2)

Written into `docs/OWNER_DECISIONS_2026-09-24.md`:
- **D-cost — answered.** Direction-dependent: long 0.34%, short 0.14% (USDC/USDT-funded
  positions), fallback 0.20% for an unresolved direction. Applied as the `dir-cost`
  column above and in `scripts/replay-rules.js`'s `netR_sensDir`.
- **D-variant — floor answered** (≥3 conditional/day combined; GOOD/hr reported, no
  GOOD floor yet), **variant pick still open**: the floor is cleared by all variants, so
  the mechanical best-expectancy answer is V-B, but V-B's gross-floor rule change needs
  its own explicit sign-off before it can ship - see the doc for the open question.
