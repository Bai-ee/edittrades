# Risk sizing / drawdown study — 2026-09-26 (research only)

**Research only.** No `lib/`, `services/`, `config/`, `api/`, `public/`, or existing
script changed. No deploy, no commit made by this thread. New files: this doc,
`scripts/research/risk-sim.js`, `var/risk-sim/*.json`.

## Question

Strategy wins ~30% at ~3R gross. What wallet risk-per-trade and account-protection rules
(daily loss cap, pause-after-losses, kill switch) keep drawdown survivable, given the
13–17-trade losing streaks seen live/in replay (`docs/FREQUENCY_STUDY_2026-09-26.md`)?

## Tool

`scripts/research/risk-sim.js` — plain Node ESM, no new dependencies. Two input modes,
two simulation methods, one rule grid.

```bash
# File mode: replay real call records (dir-cost net R: netR_sens034 long / netR_sens014 short)
node scripts/research/risk-sim.js --calls var/replay-rules/V6.calls.jsonl \
  [--filter-min-stop 0.5] [--filter-max-costr 0.35] \
  [--paths 10000] [--trades 300] [--trades-per-day 5] [--seed 42] [--out name]

# Parametric mode: no file, two-outcome distribution
node scripts/research/risk-sim.js --param win=0.31,winR=2.6,lossR=1.34 \
  [--paths 10000] [--trades 300] [--trades-per-day 5] [--seed 42] [--out name]
```

- **Input filter** (file mode only): keeps `outcome` in `{win, loss}` (drops `open`/pending),
  `stopDistancePct >= --filter-min-stop`, and `costR <= --filter-max-costr` where
  `costR = (0.34% long / 0.14% short) / stopDistancePct`. R value used is the dir-cost net R
  (`netR_sens034` long, `netR_sens014` short), matching the owner's D-cost convention used in
  `docs/FREQUENCY_STUDY_2026-09-26.md`.
- **Two methods:**
  (a) **historical** — one deterministic pass over the actual chronological sequence of
  filtered/resolved calls (file mode only; there is no "real sequence" in param mode).
  (b) **bootstrap** — Monte Carlo, `--paths` paths of `--trades` trades, each trade resampled
  with replacement from the filtered R distribution (file mode) or drawn iid from the
  parametric win/winR/lossR distribution (param mode).
- **Equity model:** compounding, `equity *= 1 + riskPct/100 * R` per trade taken.
- **Rule grid** (32 cells = 4 riskPct × 2 dailyCap × 2 pause × 2 kill):
  - `riskPct ∈ {0.5, 0.75, 1, 2}` (% of current equity risked per trade)
  - `dailyLossCapR ∈ {none, 3}` — stop trading for the rest of the day once realized R lost
    *that day* reaches −3R
  - `pauseAfterLosses ∈ {none, 6}` — after 6 consecutive losses, sit out the rest of the day
  - `killSwitchDD ∈ {none, 15%}` — stop trading the path for good once equity drawdown from
    peak reaches 15%
- **Day grouping:** historical mode uses the actual UTC calendar day of `firstReadyAt`.
  Bootstrap mode has no real calendar (trades are iid-resampled), so "day" is approximated
  as a fixed-size chunk of `--trades-per-day` trades (default 5, matching the ~5/day baseline
  frequency in `docs/FREQUENCY_STUDY_2026-09-26.md`). This is a simplification — a real day
  is smeared across chunk boundaries — documented rather than hidden. `pauseAfterLosses`
  resets its consecutive-loss counter at each day boundary; the kill switch is **not**
  day-scoped — once it trips, the path stops for the rest of the run, per spec.
- **RNG:** seeded (mulberry32, `--seed`, default 42) for reproducible runs.
- Prints markdown tables to stdout; writes full JSON (`bootstrap[]`, `historical[]` per
  rule cell) to `var/risk-sim/<name>.json`.

## Parametric validation scenarios

Expectancy per trade = `win*winR - (1-win)*lossR`. All runs: `--paths 10000 --trades 300 --seed 42`.

### (1) win 0.31 / winR 2.6 / lossR 1.34 — "3R plan" at ~1% stop, long costs

Expectancy = **−0.1186R**. Note: at a 1%-ish stop with the owner's dir-cost convention,
the ~3R gross plan already nets to a small **negative** edge before any account-protection
rule — consistent with `docs/FREQUENCY_STUDY_2026-09-26.md`'s finding that every rule
variant's net expectancy (dir-cost) is negative on the current data. This scenario is a
stress test of risk sizing under a realistic-but-still-losing edge, not a proof the edge is
positive.

| riskPct | dailyCap | pause | kill | median finalX | p5 finalX | median maxDD | p95 maxDD | P(DD≥20%) | P(DD≥30%) | med streak | P(kill) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.5% | none | none | none | 0.83x | 0.64x | 24.4% | 39.0% | 69.5% | 27.2% | 5 | n/a |
| 0.5% | 3 | 6 | none | 0.85x | 0.67x | 22.2% | 35.8% | 61.3% | 17.3% | 4 | n/a |
| 0.5% | none | none | 15% | 0.88x | 0.85x | 15.2% | 15.5% | 0.0% | 0.0% | 5 | 88.6% |
| 1% | none | none | none | 0.67x | 0.40x | 44.2% | 63.7% | 98.4% | 85.7% | 5 | n/a |
| 1% | 3 | 6 | none | 0.70x | 0.44x | 40.4% | 59.5% | 97.3% | 79.5% | 4 | n/a |
| 1% | none | none | 15% | 0.89x | 0.84x | 15.4% | 16.1% | 0.0% | 0.0% | 5 | 99.8% |
| 2% | none | none | none | 0.40x | 0.15x | 70.5% | 87.8% | 100.0% | 99.7% | 5 | n/a |
| 2% | 3 | 6 | 15% | 0.90x | 0.84x | 15.3% | 16.3% | 0.0% | 0.0% | 3 | 100.0% |

Full 32-row grid: `var/risk-sim/param-3R-1pct-stop.json`.

### (2) win 0.31 / winR 1.64 / lossR 2.36 — 0.25% stop, negative edge

Expectancy = **−1.12R** (deeply negative — a tight stop means costs eat most of the win
size while the loss side grows). Ruinous at every risk level without a kill switch:

| riskPct | dailyCap | pause | kill | median finalX | P(DD≥30%) | P(kill) |
| --- | --- | --- | --- | --- | --- | --- |
| 0.5% | none | none | none | 0.18x | 100.0% | n/a |
| 1% | none | none | none | 0.03x | 100.0% | n/a |
| 2% | none | none | none | 0.00x | 100.0% | n/a |
| 1% | none | none | 15% | 0.85x | 0.0% | 100.0% |

Full grid: `var/risk-sim/param-negative-edge-025pct-stop.json`.

### (3) win 0.25 / winR 3 / lossR 1 — exact breakeven sanity check

Expectancy = **0.0000R** exactly. At low risk, median final equity sits just under 1x as
expected from volatility drag on a compounding, zero-edge process:

| riskPct | dailyCap | pause | kill | median finalX | p5 finalX | median maxDD | P(DD≥20%) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.5% | none | none | none | 0.99x | 0.78x | 15.4% | 25.6% |
| 1% | none | none | none | 0.96x | 0.59x | 29.2% | 85.4% |
| 2% | none | none | none | 0.84x | 0.33x | 51.1% | 100.0% |

Drag scales with risk² as expected (0.5%→1x, 1%→~0.96x, 2%→~0.84x). Sanity check passes.
Full grid: `var/risk-sim/param-breakeven-sanity.json`.

## File-mode smoke test — `var/replay-rules/V6.calls.jsonl`

172 resolved calls (win rate 30.2%, no filters applied) — small sample, used only to prove
the file-mode/dir-cost/day-grouping code path works end to end, **not** a production risk
read (real reads land once `var/cost-gate/*.calls.jsonl` exists, see below).

Historical replay (single real sequence, no rules, 0.5% risk): finalX 0.73x, maxDD 36.1%,
longest losing streak **11** (this small 172-trade sample; broader replay studies on this
codebase have seen 13–17, see Reading below). With `dailyLossCapR=3` alone: finalX rises to
1.01x, maxDD drops to 12.5% — on this particular historical sequence the daily cap alone
recovers to breakeven-ish while cutting drawdown by two-thirds. Bootstrap (10k paths) tells
the harsher truth: median finalX 0.58x at 0.5% risk with no rules, because most 300-trade
resampled paths don't get this exact favorable sequencing. Full tables in
`var/risk-sim/V6-smoke-test.json` and reproduced by rerunning the command above.

## Reading

- **This strategy's edge, as parameterized here, is flat-to-negative after dir-cost fees**
  at realistic stop widths (scenario 1: −0.12R/trade). That is the dominant risk driver —
  no sizing rule fixes a negative-expectancy process, it only changes how slowly you find
  out. Every table here should be read as "how fast does this lose" unless/until a
  positive-edge input is confirmed on real data.
- **Risk % is the single biggest lever on drawdown.** Moving from 2% → 0.5% per trade cuts
  median max DD roughly in half to a third across every scenario (e.g. scenario 1: 70%→24%
  median DD; scenario 3 breakeven: 51%→15%). Given the 13–17-trade losing streaks documented
  in `docs/FREQUENCY_STUDY_2026-09-26.md`, **0.5%, and arguably lower (0.25%), is the only
  riskPct tested that keeps p95 max DD near/under ~20–25%** even at breakeven-to-slightly-
  negative edge; 1% and 2% both blow through 20% DD in the large majority of paths once a
  15-loss-in-a-row stretch is in the cards (15 straight losses at `lossR=1.34`, 1% risk,
  compounds to `(1 - 0.01*1.34)^15 ≈ 0.82` — ~18% down from losses alone, before the daily
  cap or pause rule would even have a winner to reset against).
- **Daily loss cap (−3R) and pause-after-6-losses help, modestly, and mostly by capping
  losing days rather than by improving the edge.** Across every scenario they shave several
  points off median/p95 max DD and P(DD≥20/30%) (e.g. scenario 1 at 1% risk: P(DD≥30%)
  85.7%→79.5% with dailyCap+pause) — real but second-order next to the risk% choice itself,
  and they cost little upside in a negative-edge process (there isn't much upside to protect).
  In a positive-edge process they would trade away some winning days along with losing ones;
  this study didn't have a positive-edge input to test that tradeoff directly.
- **The 15% kill switch is the one rule that changes the outcome qualitatively, not just
  quantitatively.** In every scenario it clamps median max DD to ~15–17% and P(DD≥20/30%) to
  ~0% by construction (it stops the path once DD hits 15%), at the cost of a near-certain
  "game over" flag (P(kill triggered) 83–100% across the negative/breakeven scenarios tested)
  and it freezes upside exactly where it fires. It is a capital-preservation stop, not a
  return enhancer: read the high P(kill) numbers as "this process, as parameterized, is not
  survivable without one," not as a rule to tune for performance.
- **Net effect on upside:** none of the three protection rules improve median final equity
  in a negative-edge process — dailyCap/pause trade a little variance for a little median
  uplift (scenario 1, 1% risk: median finalX 0.67x→0.70x), while the kill switch trades away
  most of the variance (and most of the tail loss) but also caps the best paths at wherever
  DD=15% first hits, which is why its median finalX (0.85–0.91x) is well above the no-kill
  runs but not close to 1x. There is no rule combination here that turns a negative-edge
  process profitable; that has to come from the edge itself.

**Recommended default, given current information:** ~0.5% risk per trade, daily loss cap at
−3R, and a 15% equity kill switch. Pause-after-6-losses is a cheap add-on with a small
effect; keep it if it's easy to wire, skip it if not — it isn't doing the heavy lifting.
This is a sizing/protection default, not a claim the strategy is profitable; it should be
revisited once real dir-cost net R is confirmed positive on live data.

## Real-data status

`var/cost-gate/*.calls.jsonl` does not exist yet as of this writing (another agent is
running that replay concurrently). Once it lands, rerun:

```bash
node scripts/research/risk-sim.js --calls var/cost-gate/<file>.calls.jsonl \
  --filter-min-stop 0.5 --filter-max-costr 0.35 --paths 10000 --trades 300
```

and replace the smoke-test section above with the real read.

## Fix 2026-09-27 — longest-streak metric

The longest-losing-streak metric reset at every day boundary (it shared the pause rule's
per-day counter), so with 1 trade/day it always read 1. It now uses a separate run counter
that only resets on a win. The pause rule is unchanged. Equity, drawdown and kill figures were
not affected. First real-data run (cost-gate V6 ≥0.8% stop, 0.15% long cost): see
`docs/COST_GATE_STUDY_2026-09-26.md` → "Addendum 2026-09-27".
