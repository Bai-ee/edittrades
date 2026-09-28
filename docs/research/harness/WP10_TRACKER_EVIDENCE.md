# WP10 — forward-evidence suite over the tracker's recorded captures

Status: built 2026-09-27, research-only, read-only against `../edittrades-tracker/data`.
Branch `edge/wp10-tracker-evidence`. Master plan: `docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md`
WP10. Backlog items: `EXTERNAL_HARNESS_REFERENCES.md` R10+, R11, R12, R14, R15; 4.3.

Code: `scripts/research/tracker-evidence/{lib,horizon-backfill,wait-scoring,confidence-calibration,reason-attribution,side-mix,drift}.js`.
Tests: `test-wp10-{lib,horizon-backfill,wait-scoring,confidence-calibration,reason-attribution,side-mix,drift}.js`
(55 assertions, all pass, hand fixtures only — no live tracker data is read by the tests).
Outputs: `var/research/wp10-tracker-evidence/*.json(l)` (regenerate with the commands below).

**Nothing here changes live engine behaviour.** This is measurement only, per
`docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md`'s scope boundary.

## Data coverage

- Source: `../edittrades-tracker/data` (read-only; the tracker's own automatic collector).
- Capture days: **5** (`2026-09-23` through `2026-09-27`), **1,803** capture rows before
  dedupe, **1,803** after (symbol+`closedThrough` dedupe found no duplicate keys to collapse
  in this window — see "Limitations").
- Candle store: 1m candles for BTC/ETH/SOL (18,036 rows total), 15m candles (1,125 rows,
  used only for the ATR(15m) stop-proxy fallback).
- Actionable (class `GOOD`, ready flag plan) rows: **6** in the entire window. Ready/
  conditional flag-plan rows (`kind: 'plan'`) that resolved tp1/stop in the tracker's own
  `data/outcomes.jsonl`: **7**.
- BTC 4h long-history regime reference: `var/edge/4h-long/BTC_4h.json` (19,955 bars back to
  2017-08, fetched by WP7/WP8, read-only, not tracker data).

**Headline caveat that applies to every section below:** five days and single-digit
actionable-trade counts is a very small, single-regime sample. Every table states its own
`n`; anything under 30 is marked `INSUFFICIENT` per the work package's own rule, not
suppressed. Findings are reported as evidence to revisit once more days accumulate, not as
conclusions.

---

## 1 — R12 fixed-horizon backfill

Command: `node scripts/research/tracker-evidence/horizon-backfill.js --data ../edittrades-tracker/data --out var/research/wp10-tracker-evidence`

For every deduped capture row, close return / MFE / MAE at 15m / 1h / 4h, both directions,
in % and (via `flagTradePlan` entry/stop, or a 1×ATR(15m) proxy) in R. Completeness:

| Horizon | pending | complete | partial | unscorable | unscored share |
| --- | --- | --- | --- | --- | --- |
| 15m | 6 | 1,797 | 0 | 0 | 0% |
| 1h | 24 | 1,779 | 0 | 0 | 0% |
| 4h | 81 | 1,722 | 0 | 0 | 0% |

Zero `partial`/`unscorable` rows at every horizon: the tracker's 1m candle store has no
internal gaps over these 5 days. `pending` rows are only the last 6/24/81 minutes of the
capture window (the horizon hasn't elapsed in the data yet) — the completeness state
machine is working as designed, not masking missing data. Output row-level dataset:
`var/research/wp10-tracker-evidence/horizon-backfill.jsonl` (1,803 rows × 3 horizons × 6
fields each), reused by every other section below.

---

## 2 — R11 WAIT / no-trade outcome scoring ("missed trades")

Command: `node scripts/research/tracker-evidence/wait-scoring.js ...`

The engine has no literal `WAIT`/`NO_TRADE` state; `WATCH` and `BAD` classes stand in for
"not actionable" (1,797 of 1,803 rows). Each is walked forward from the decision price with
no entry zone (the tracker's own `data/outcomes.jsonl` only walks WATCH via a candidate's
breakout zone, so it can't see opportunity cost when the zone was never touched — this is
the gap R11 fills). "Missed" = reaches +1R before −1R, in the engine's own leaned direction,
within a 4h hold, using the plan's stop (present even on a rejected plan) or a 1×ATR(15m)
proxy. Reported at two units — do not average them:

| Cut | n scorable | missed | missed rate | 90% CI (day-block bootstrap) |
| --- | --- | --- | --- | --- |
| Per capture row (every WATCH/BAD snapshot) | 1,789 | 745 | 41.6% | [39.9%, 43.4%] |
| Per opportunity (deduped by candidateId, first sighting) | 1,073 | 461 | 43.0% | [39.1%, 46.3%] |

By class (per-opportunity): WATCH 41.4% (n=830), BAD 48.2% (n=243).

Forward distribution (per-opportunity, R-equivalent, leaned direction): 1h mean MFE
+1.38R / mean MAE −1.60R (n=1,078); 4h mean MFE +2.93R / mean MAE −3.18R.

**Actionable-call comparison** (from the tracker's own `data/outcomes.jsonl`, INSUFFICIENT,
n≪30): GOOD-class recs converted to TP1 33.3% of the time (n=6); ready/conditional flag
plans converted to TP1 28.6% of the time (n=7).

The engine's own executed/ready trades hit their (larger, measured-RR) target less often
than a naive symmetric ±1R coin-flip-timed-anywhere hits +1R within 4h. This is **not**
apples-to-apples (different R targets, no cost adjustment, tiny actionable n), but it is
exactly the kind of gap R11 exists to surface and is one of this WP's headline findings
(§ Top findings, #1).

---

## 3 — R15 calibration of the headline confidence field

Command: `node scripts/research/tracker-evidence/confidence-calibration.js ...`

**Finding, not a workaround:** the only continuous 0–100 confidence value the engine emits
(`flagRecommendation.trace.score`, the `quality_score` behind `qualityBand`,
`lib/flagRecommendation.js` `scoreContext`/`finish`) is **architecturally computed only when
a flag plan reaches `ready`** (class `GOOD`). It is `null` on every `WATCH`/`BAD` row. In 5
days that is **n=6** — decile calibration is `INSUFFICIENT` by construction, not by bad
luck; it stays that way until GOOD calls accumulate into the hundreds.

| Decile | n | resolved | TP1 rate | mean R |
| --- | --- | --- | --- | --- |
| 70–80 | 2 | 2 | 50% | +0.89 |
| 80–90 | 4 | 4 | 25% | −0.11 |
| all others | 0 | – | – | – |

Brier (6 resolved pairs): 0.467 — worse than a coin flip (0.25 baseline for p=0.5
everywhere), on n=6; not interpretable yet.

**Supplementary, coarser, much larger-n check:** `qual.quality` (high/med/low — itself a
band of a 0–100 confidence never persisted to the capture row), joined to each candidate's
own forward 1h return (candidate-deduped, one row per candidateId):

| Band | n | directional hit rate (1h) | mean R (1h) |
| --- | --- | --- | --- |
| high | 746 | 43.8% | −0.18 |
| med | 298 | 46.5% | −0.04 |
| low | 33 | 37.5% | −0.50 |

`high` underperforms `med` on both hit rate and mean R. This is correlational, single-regime
(5 days, all bull per §5), and not cost-adjusted — but the direction (higher confidence band
≠ better forward outcome) is the opposite of what the label should mean, and is the second
headline finding.

---

## 4 — R14 reason-code attribution

Command: `node scripts/research/tracker-evidence/reason-attribution.js ...`

Only 6 rows ever reach class `GOOD`, so "incremental net R with vs without a code" cannot be
computed on **executed** trades — there is nothing to split. Instead every structured code a
row carries (`flagTradePlan.reasonCode`, `primaryReason.code`, `supports[]`, `opposes[]`,
the primary candidate's `qual.reasons[]`; `rr:*`, `level:*` and any bare-number-suffixed
token like `tp1_capped:84042.1` excluded as price-specific, not categorical) is attributed
against the **row's own forward 1h R-equivalent**, in its leaned direction — a
candidate/recommendation-state correlation, not a trade-cost comparison. Both framings are
stated explicitly; do not conflate them. 93 distinct codes seen with n≥5; 71 with n≥30.
Day-block bootstrap 90% CI (5 days).

Top codes by |Δ mean R| among n≥30 (not cherry-picked for direction — both signs shown):

| Code | n (with) | mean R with | mean R without | Δ | 90% CI (with) |
| --- | --- | --- | --- | --- | --- |
| `opposes:a200:3/7` | 53 | +1.21 | −0.20 | +1.41 | [0.89, 1.55] |
| `supports:a200:4/7` | 85 | +0.89 | −0.21 | +1.10 | [0.48, 1.64] |
| `opposes:ema200:1m:below` | 60 | +0.82 | −0.19 | +1.01 | [0.63, 0.98] |
| `supports:td:bull:2/4` | 177 | +0.52 | −0.23 | +0.75 | [0.36, 0.91] |
| `opposes:ema200:3m:below` | 54 | +0.45 | −0.18 | +0.62 | [0.12, 0.98] |
| `opposes:td:bull:2/4` | 116 | −0.72 | −0.12 | **−0.60** | [−0.84, −0.28] |
| `opposes:conflict:3m-short` | 49 | +0.42 | −0.17 | +0.59 | [0.10, 0.56] |
| `opposes:conflict:5m-short` | 78 | +0.38 | −0.18 | +0.57 | [0.22, 0.48] |

Read with caution: `a200:x/7` and `td:bull:x/4` are alignment-count tokens that co-move with
the 5-day bull regime (§5) almost by construction — a code counting "how many timeframes
agree with the (one) prevailing trend" will look predictive of a 1h return in a window that
only contains that one trend. This is exactly the kind of result R3/R3b (a separate WP) is
meant to stress-test with matched controls; treat this table as a candidate list for that
follow-up, not a verified attribution. Full 93-code table in
`var/research/wp10-tracker-evidence/reason-attribution.json`.

---

## 5 — 4.3 side-mix audit

Command: `node scripts/research/tracker-evidence/side-mix.js ...`

Current regime (BTC 4h close vs SMA200, `var/edge/4h-long/BTC_4h.json`, evaluated with no
lookahead): **bull** throughout the entire 5-day capture window (BTC ≈ $84.9k vs
SMA200 ≈ $79.7k at the end of the window). There are **zero bear-regime rows** in this
dataset — a bull-vs-bear side-mix comparison cannot be made yet; only the current state can
be reported.

Actionable calls (class GOOD ∪ ready plan status), n=6: **1 long / 5 short (16.7% / 83.3%)**
— mostly short, in a bull regime. n=6 is far too small to call this systematic, but it is
directionally the opposite of what "aligned with the trend" would predict, and is the third
headline finding.

Rejection-code mix, counter-trend vs trend-aligned rejected candidates (n=217 vs n=270): the
counter-trend group is dominated by `divergence_conflicts` (217/217), `ct:4h` (168/217) and
`td:bull:4/4` (136/217) — trend-awareness codes that barely appear in the trend-aligned
group's top list (`ct:4h` only 65/270, no `td:bull:4/4`). **The gating logic is doing its
job on rejected counterfactuals** — it disproportionately blocks counter-trend setups with
trend-specific codes. The tension is that the tiny set of setups that *do* reach GOOD still
skews short. Full code lists: `var/research/wp10-tracker-evidence/side-mix.json`.

---

## 6 — R10+ drift-baseline report

Command: `node scripts/research/tracker-evidence/drift.js ...`

Baseline = earlier half, current = later half of the tracker's own **flag-plan ledger only**
(`data/outcomes.jsonl` `kind: 'plan'`, resolved tp1/stop — deliberately excludes `kind: 'rec'`
WATCH/BAD counterfactual rows, which would double-count the same event and carry the cost
artifact in §"Limitations" below).

| | n | TP1 rate | mean gross R | mean net R | cost drag (R) | calls/day |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline (earlier) | 3 | 0% | −1.00 | −2.17 | 1.17 | 1.5 |
| Current (later) | 4 | 50% | +0.83 | −2.32 | 3.15 | 1.3 |

**State: `INSUFFICIENT`** (`n<30` on both sides — the rule fires correctly; this is the
expected, correct output today, not a bug). Thresholds are provisional and documented in
`drift.js` (`THRESHOLDS`): WATCH at −0.2R/−15pp, ALERT at −0.5R/−30pp expectancy/TP1-rate
drop, `MIN_N=30`. The mechanism (freeze → compare → state; never auto-retunes anything) is
built and tested; it simply has nothing to say yet with n=7 total.

---

## Top 3 actionable signal-quality findings

1. **Tight stops on 1m-timeframe flag plans make the tracker's flat round-trip cost model
   dominate net R.** All 7 resolved ready/conditional flag plans in this window are 1m
   timeframe with stop distances of 0.02%–0.49% of entry. The flat 14–34bps round-trip cost
   (`scripts/tracker/costs.js`) turns that into 0.6R–7.0R of cost per trade — both of the
   window's nominal TP1 "wins" (gross +2.79R, +2.55R) become **net losses** once costs are
   applied (−0.97R and −4.42R respectively), because their stops were 0.037% and 0.020% from
   entry. Net expectancy on this ledger is strongly negative (mean net R −2.2 to −2.3)
   despite the current-window TP1 rate improving to 50% and mean **gross** R turning
   positive (+0.83). Any edge claim on 1m-timeframe flag plans needs either materially wider
   stops or a cost/sizing model that isn't a flat bps-of-entry charge against a stop this
   tight. (§2 actionable comparison, §6 drift table.)

2. **The engine's own confidence signal doesn't calibrate in the direction it should, on
   what data exists.** The only true 0–100 confidence field (`trace.score`) is only ever
   populated on GOOD calls (n=6, structurally — not a data gap), so it can't be decile-
   calibrated yet. The larger-n proxy that *is* available everywhere — `qual.quality`
   (high/med/low), candidate-deduped, n=746/298/33 — shows `high` confidence candidates with
   a **lower** directional hit rate (43.8%) and worse mean R (−0.18) than `med` (46.5%,
   −0.04). Single regime, 5 days, correlational — but the direction is backwards for a
   confidence label, and is worth watching as more days accumulate. (§3.)

3. **The gates correctly filter counter-trend setups on the reject path, but the handful of
   calls that make it all the way to GOOD still skew against the 5-day bull regime**
   (1 long / 5 short, n=6). Rejected counter-trend candidates are dominated by trend-aware
   codes (`ct:4h`, `td:bull:4/4`, `divergence_conflicts`) that barely appear on the
   trend-aligned reject path — the filtering logic is doing real work — yet it isn't
   sufficient to keep the tiny GOOD population trend-neutral. n=6 is nowhere near enough to
   call this systematic; it's a candidate for R3b's matched-random control once actionable
   n is larger. (§5.)

---

## Limitations (apply across all six sections)

- **Five capture days, one market regime (bull throughout).** No bear-regime data exists yet
  for any bull/bear comparison (§5). Every finding above should be re-checked once the
  window spans a regime change.
- **Row-level vs opportunity-level double counting.** A candidate that stays `forming` for
  20 minutes is captured many times at the ~1–10 minute cron cadence. §2 and §3's `high`
  qual-band table are computed candidate-deduped (first sighting only); §4's code
  attribution and §5's rejection-code mix are **not** deduped this way (a code's
  "with"/"without" split is over capture rows, so a persistently-rejected candidate is
  overweighted). Treat §4/§5 code counts as descriptive, not as independent-trial evidence.
- **R14's attribution is correlational over engine state, not a trade-cost comparison** —
  stated in §4, repeated here because it's the easiest thing to misread from the table
  alone.
- **The `trace.score`/`qualityBand` confidence field is architecturally GOOD-only** (§3) —
  this is a property of `lib/flagRecommendation.js`, not a tracker gap; a decile-calibration
  request against this field will stay `INSUFFICIENT` until many more GOOD calls exist,
  regardless of how many days pass, unless the GOOD rate itself rises.
- **No dedupe collapsed anything in this window** (0 of 1,803 rows shared a symbol+
  `closedThrough` key) — `loadDedupedCallRows`'s cron-wins-over-served rule is implemented
  and unit-tested (`test-wp10-lib.js`) but unexercised by this particular 5-day sample.
- Nothing in this WP reads, needs, or was blocked by network access, `.env`, or live
  engine/config files; `scripts/tracker/{store,walk-outcome,costs}.js` were imported
  read-only and never modified.
