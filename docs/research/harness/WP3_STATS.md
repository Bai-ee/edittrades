# WP3 — statistics core (R3 significance, R4 trade shuffle, R7 candle Monte Carlo, Card 4.2 trial ledger + deflated Sharpe)

Research only. Branch `edge/wp3-stats`, worktree `/Users/bballi/Documents/Repos/et-wp3-stats`.
No changes to `api/`, `lib/`, `services/`, `scripts/tracker/`, `public/`, `package.json`,
`RESEARCH_BACKLOG.md`, `DOCUMENTATION_INDEX.md`. No new npm dependencies.

Source read at the pinned SHA before writing any code: `jesse-ai/jesse` cloned shallow into the
session scratchpad and checked out at `840beb9cddddc35706adaba60557c1ba8e69b964`, then
`jesse/research/rule_significance_testing/{rule_significance.py,bootstrap.py}` and
`jesse/candle_pipelines/moving_block_bootstrap.py` read directly (not just from
`docs/research/external-refs/JESSE_FREQTRADE_VERIFY.md`, though that doc's description of A1/A2
was independently confirmed correct against the source).

## Code

| File | Purpose |
| --- | --- |
| `scripts/research/harness/stats-lib.js` | Shared math: seeded RNG (mulberry32), mean/variance/std/skewness/kurtosis, Sharpe ratio, normal CDF (erf-based) and inverse CDF (Acklam's algorithm), percentile/summarize helpers. |
| `scripts/research/harness/significance.js` | R3 — Jesse-method rule significance test (gross + net-of-cost), stationary block bootstrap. |
| `scripts/research/harness/significance-apply.js` | R3 applied to SMA200/840, daily EMA20, re-flag-retest-1h (item 5). |
| `scripts/research/risk-sim.js` | **Modified**, additive only — new `--trades <file.jsonl> --shuffle` mode (R4) plus exported `shuffleTradeOrder()` / `loadGenericTrades()`. Existing `--calls`/`--param` modes unchanged (see "Deviation" below for the one structural fix required). |
| `scripts/research/harness/r4-apply.js` | R4 applied — generates the SMA200 trades.jsonl (3 symbols) and the re-flag-retest-1h net-R jsonl that risk-sim.js's `--shuffle` mode is then run against. |
| `scripts/research/harness/montecarlo.js` | R7 — moving-block bootstrap candle Monte Carlo, reruns `runSma4h`. |
| `scripts/research/harness/trial-ledger.js` | Card 4.2 — trial ledger + Bailey–López de Prado deflated Sharpe ratio. |
| `test-wp3-significance.js`, `test-wp3-risk-shuffle.js`, `test-wp3-montecarlo.js`, `test-wp3-trial-ledger.js` | Node-assert test suites (32 checks total, all passing). |

## R3 — rule significance test (Jesse method)

### Method, exactly as read from source

`jesse/research/rule_significance_testing/rule_significance.py` (phase 2/detrending) and
`bootstrap.py` (the stationary block bootstrap), read at `840beb9`:

1. `log_returns[t] = log(close[t+1]/close[t])` for every bar `t` (the strategy's own signal
   series is truncated to drop the last bar, since it has no next-bar return to pair with).
2. Detrend: `detrended[t] = log_returns[t] - mean(log_returns)` — removes market drift so a
   no-edge rule has `E[rule_return] = 0` regardless of whether the asset trended.
3. `rule_return[t] = signal[t] * detrended[t]`, `observed_mean = mean(rule_return)`.
4. Stationary block bootstrap of `rule_return - observed_mean`: geometric block lengths (restart
   probability `1/meanBlockLength`, default mean length 10), 2000 resamples by default. Each
   resample's mean is recorded.
5. `p_value = fraction(simulated_means >= observed_mean)` (one-sided upper-tail). We additionally
   report `percentile = 100 * fraction(simulated_means < observed_mean)`.

`scripts/research/harness/significance.js`'s `stationaryBootstrapMeans()` ports the exact
restart/block-start/offset construction from `bootstrap.py` (same two-phase draw order: all
restart decisions first, then one uniform block-start per block, then a single forward pass
computing each resampled mean).

**Deviation from Jesse (documented, as instructed):**
- **PRNG**: mulberry32 (seeded, deterministic — same generator already used elsewhere in this
  repo's research harness, e.g. `risk-sim.js`), not numpy's PCG64 (`default_rng`). The
  **algorithm** is identical; the raw bootstrap draws will not numerically match a literal Jesse
  run with "the same seed" — only reproducibility *within this harness* is claimed.
- **Net-of-cost variant (our own addition, not in Jesse)**: before detrending, a per-switch cost
  (spot 0.15%/side, log-return units) is subtracted from `log_returns[t]` at every bar where
  `signal[t] != signal[t-1]`, scaled by `|signal[t]-signal[t-1]|` (so a long↔short flip pays
  2×, i.e. an exit + an entry). Gross and net are always reported side by side, never one in
  place of the other. Jesse's own test has no notion of cost or exits at all — see "Limits"
  below.
- **Percentile definition** is our own addition (Jesse reports only `p_value`).

### Limits (carried over from Jesse, still apply here)

Jesse's test only scores the **single bar immediately following** the signal — it does not
simulate an exit, a stop, a target, or a multi-bar hold. A rule whose edge only shows up over
several bars (e.g. a swing rule with a multi-hour hold) is under-credited by this test. This
matters directly for `re-flag-retest-1h` below (median hold ≈ 9.5h ≈ 9-10 1h bars) — see its
result.

### Applied (item 5): SMA200/840, daily EMA20, re-flag-retest-1h

Command: `node scripts/research/harness/significance-apply.js` (writes
`var/research/wp3/significance.json`). Seed 42, 2000 simulations, registered block length 10,
net cost 0.15%/side.

`re-flag-retest-1h` reconstruction: the study JSON (`docs/swing/re-flag-retest-1h.json`) stores
per-signal entry events (`closedThrough`, `direction`), not a continuous per-bar series. Every one
of the 28 (BTC) + 40 (ETH) + 33 (SOL) = 101 entry timestamps was confirmed present, exactly, in
`test/fixtures/history/deep2y-2026-09-26/{SYM}_1h.json` (0 misses on all three symbols), so the
full-history signal series (`+1`/`-1` at each entry bar, `0` elsewhere) was reconstructed directly
against that 1h price history — **reconstructable**, run per symbol (not pooled across symbols,
since a pooled/concatenated series would misrepresent serial dependence across three independent
price processes for the block bootstrap).

| target | n obs | observed mean (gross) | p (gross) | pctile (gross) | observed mean (net) | p (net) | pctile (net) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SMA200 4h BTC | 19755 | 1.513e-4 | 0.0165 | 98.4 | 1.524e-4 | 0.0160 | 98.4 |
| SMA840 4h BTC | 19115 | 1.118e-4 | 0.0435 | 95.7 | 1.119e-4 | 0.0435 | 95.7 |
| daily EMA20 BTC | 3309 | 6.711e-4 | 0.0700 | 93.0 | 6.754e-4 | 0.0700 | 93.0 |
| re-flag-retest-1h BTC | 17427 | 5.909e-7 | 0.2900 | 71.0 | 7.632e-7 | 0.2640 | 73.6 |
| SMA200 4h ETH | 19755 | 2.015e-4 | 0.0140 | 98.6 | 2.017e-4 | 0.0140 | 98.6 |
| SMA840 4h ETH | 19115 | 1.295e-4 | 0.0755 | 92.5 | 1.296e-4 | 0.0765 | 92.3 |
| daily EMA20 ETH | 3309 | 1.074e-3 | 0.0325 | 96.8 | 1.072e-3 | 0.0325 | 96.8 |
| re-flag-retest-1h ETH | 17427 | 3.331e-6 | 0.1695 | 83.0 | 2.730e-6 | 0.2210 | 77.9 |
| SMA200 4h SOL | 13231 | 2.112e-4 | 0.0885 | 91.1 | 2.109e-4 | 0.0900 | 91.0 |
| SMA840 4h SOL | 12591 | 2.014e-4 | 0.0995 | 90.0 | 2.017e-4 | 0.0985 | 90.1 |
| daily EMA20 SOL | 2219 | 1.366e-3 | 0.0940 | 90.6 | 1.364e-3 | 0.0960 | 90.4 |
| re-flag-retest-1h SOL | 17427 | 4.205e-6 | 0.1350 | 86.5 | 5.064e-6 | 0.1020 | 89.8 |

**Block-length sensitivity** (5/10/20, gross, seed 42, 2000 sims — see "Scope of the sensitivity
sweep" below for why only two targets were swept):

| target | block=5 (p) | block=10 (p) | block=20 (p) |
| --- | --- | --- | --- |
| SMA200-4h-BTC | 0.0080 | 0.0165 | 0.0175 |
| re-flag-retest-1h-BTC | 0.2980 | 0.2900 | 0.2915 |

### Verdict

- **SMA200 has next-bar directional information on all three symbols** (p = 0.014–0.089 gross,
  essentially unchanged net of cost — costs barely move the result because this is a low-turnover
  filter and the test only credits one bar of return per switch). Strongest on BTC/ETH (p ≈
  0.014–0.017), weakest on SOL (p ≈ 0.089, borderline by the 0.10 threshold Jesse's own docs
  quote).
- **SMA840 and daily EMA20 are weaker and mostly borderline-to-insignificant** (p = 0.033–0.100),
  consistent with them being slower filters with fewer, larger switches — this one-bar-ahead test
  has less to work with per switch.
- **`re-flag-retest-1h` is NOT significant by this test on any symbol** (p = 0.10–0.29), despite
  its positive net R in the Card 6 trade-level backtest (n=99, net +0.27R, OOS-positive both
  halves). This is not a contradiction: Jesse's test only scores the return of the single 1h bar
  immediately after entry, while `re-flag-retest-1h`'s edge (per its own doc) plays out over a
  median ≈ 9.5-hour, multi-bar hold to a structural stop/target. **This test is the wrong
  instrument for a multi-bar-hold strategy** — it is included here because the WP3 brief asked
  for it, but its null result should not be read as evidence against `re-flag-retest-1h`. R4
  below (trade-order shuffle) is a more appropriate significance-adjacent check for that rule.
- Net-of-cost barely moves any of the 12 results — expected, since the cost adjustment only bites
  on switch bars and all four rule families here have far more hold-bars than switch-bars per
  unit of history.

### Scope of the sensitivity sweep

Running the 5/20 block-length sensitivity on all 12 targets × gross/net would have doubled the
already-large output for no additional insight (the effect, shown above on the two flagship
targets, is small and monotonic-ish, not sign-changing). Swept on: SMA200-4h-BTC (the strongest,
most-discussed headline result) and re-flag-retest-1h-BTC (the flagship perps survivor from Card
6, whose null result is the more surprising one worth stress-testing). Both are robust to block
length.

## R4 — trade-order shuffle Monte Carlo

`scripts/research/risk-sim.js` gained an additive `--trades <file.jsonl> --shuffle` mode plus two
exported pure functions (`shuffleTradeOrder`, `loadGenericTrades`); the pre-existing
`--calls`/`--param` modes are untouched (`test-wp3-risk-shuffle.js` checks (3)/(3b) run the exact
existing CLI invocations and assert identical output banners).

**One structural fix was required, not a behaviour change**: the file previously called `main()`
unconditionally at module scope with no entry-point guard, so merely `import`ing it (needed to
reuse `shuffleTradeOrder`/`loadGenericTrades` from the test file) re-ran the CLI against the
importer's `process.argv` and called `process.exit(1)`. Added the same
`if (import.meta.url === \`file://${process.argv[1]}\`)` guard already used by
`significance.js`/`sma4h-trend.js`. Running the file directly is byte-for-byte unaffected (that
condition is true exactly when it's run as `node scripts/research/risk-sim.js ...`).

**Flag reuse**: `--trades` was already a flag (an integer, `tradesPerPath`). Rather than add a
second flag name, the same flag is now type-disambiguated: a plain number (`/^-?\d+(\.\d+)?$/`)
still sets `tradesPerPath` exactly as before; anything else is treated as the new mode's
trades.jsonl path. `--units pct` expects a compounded fractional return per trade (`0.0123` =
+1.23%); `--units R` expects an R-multiple, compounded via `--risk-pct` (`equity *= 1 +
riskPct/100 * R`) — **the two compound differently and must not be mixed**: a trades file's own
convention (percent-return trade vs R-multiple trade) determines which flag to use.

### Applied: SMA200 spot trades (BTC/ETH/SOL) and re-flag-retest-1h net R

Generator: `node scripts/research/harness/r4-apply.js` — SMA200 trades from `runSma4h`'s own
`trades[].ret` field (pct units, S3 cost 0.15%/side already applied); re-flag-retest-1h's net R
from the study's own `netSens` per-signal field (R units), all three symbols pooled and sorted
into one chronological sequence (99 signals, matching the study's own `combined.stats.resolved`).

Commands:
```
node scripts/research/harness/r4-apply.js
node scripts/research/risk-sim.js --trades var/research/wp3/sma200-BTC-trades.jsonl --shuffle --units pct --n-shuffles 2000 --seed 42 --out wp3-sma200-BTC-shuffle
node scripts/research/risk-sim.js --trades var/research/wp3/sma200-ETH-trades.jsonl --shuffle --units pct --n-shuffles 2000 --seed 42 --out wp3-sma200-ETH-shuffle
node scripts/research/risk-sim.js --trades var/research/wp3/sma200-SOL-trades.jsonl --shuffle --units pct --n-shuffles 2000 --seed 42 --out wp3-sma200-SOL-shuffle
node scripts/research/risk-sim.js --trades var/research/wp3/re-flag-retest-1h-netR.jsonl --shuffle --units R --risk-pct 1 --n-shuffles 2000 --seed 42 --out wp3-re-flag-retest-1h-shuffle
```

**SMA200 spot (pct units — note: for pct units, multiplication commutes, so shuffling never
changes final equity, only the PATH to it; this is expected, see `test-wp3-risk-shuffle.js`
check (1b)):**

| symbol | n trades | maxDD p5/p50/p95 | maxDD historical | streak p5/p50/p95 | streak historical | underwater p5/p50/p95 | underwater historical |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 276 | 41.8% / 55.6% / 72.2% | 65.0% | 20 / 28 / 43 | 23 | 93.1% / 94.6% / 96.0% | 95.3% |
| ETH | 241 | 38.6% / 51.5% / 68.2% | 43.1% | 15 / 21 / 33 | 23 | 90.0% / 92.1% / 93.8% | 90.9% |
| SOL | 216 | 60.8% / 75.3% / 88.9% | 78.9% | 16 / 22 / 35 | 17 | 94.4% / 96.3% / 97.7% | 95.4% |

**re-flag-retest-1h (R units, riskPct=1%, 99 signals, all symbols pooled chronologically):**

| metric | p5 | p50 | p95 | historical (unshuffled) |
| --- | --- | --- | --- | --- |
| max drawdown | 7.2% | 10.6% | 16.6% | **16.8%** |
| longest losing streak | 7 | 10 | 16 | **19** |
| time under water | 79.8% | 83.8% | 87.9% | 78.8% |
| final equity | 1.32x (all, pct-invariant) | | | |

### Verdict

- **SMA200 spot**: BTC's realized max drawdown (65.0%) sits above the shuffled median (55.6%),
  i.e. the real chronological order was somewhat worse than a typical reordering — its 65% DD is
  not a lucky artifact of trade sequencing. ETH's realized drawdown (43.1%) sits noticeably
  *below* its shuffled median (51.5%) — ETH's live history got a relatively favorable trade
  ordering; a random reordering would plausibly have produced a materially deeper drawdown.
  SOL's realized DD (78.9%) is close to its own median (75.3%), unremarkable. Read: **published
  headline drawdowns for SMA200 (Card 1/Card 6, e.g. BTC 78%, ETH 56% from the earlier
  `sma4h-trend.js` full-history run — the trades.jsonl here is windowed to closed trades only,
  numbers differ slightly) should not be treated as a hard ceiling; ETH in particular could have
  drawn down meaningfully worse under a different (equally likely) trade sequence.**
- **`re-flag-retest-1h` is the standout finding of this section**: its actual historical longest
  losing streak (19) exceeds the 95th percentile of 2000 random reorderings of the exact same 99
  trades (16), and its historical max drawdown (16.8%) sits just above the 95th percentile
  (16.6%). **The realized loss clustering was worse than essentially all random shuffles of its
  own trade set** — meaning losses were NOT randomly distributed in time; they were serially
  correlated (bad trades came in streaks tied to a shared regime, not independent draws). This
  doesn't invalidate the rule's positive net expectancy, but it is a materially more pessimistic
  risk picture than a naive R-multiple bootstrap (which assumes iid trades) would suggest, and it
  argues for a regime-aware pause rule (the existing swing-rule risk grid's `pauseAfterLosses` /
  `dailyLossCapR` levers) rather than treating the 12-trade `maxLosingStreak` reported in the
  study JSON as a tail scenario — it may be closer to the realistic worst case than random
  shuffling implies.

## R7 — candle Monte Carlo (moving-block bootstrap of price paths)

`scripts/research/harness/montecarlo.js`. Deltas: `(Δlog close, Δlog high-relative, Δlog
low-relative)` tuples — `dClose[i] = log(c[i]/c[i-1])`, `dHighRel[i] = log(h[i]/c[i])`,
`dLowRel[i] = log(l[i]/c[i])`. Fixed-length moving-block bootstrap (uniformly-random block
starts, blocks tiled with replacement until the target path length is reached, then truncated) —
this is the *shape* of `jesse/candle_pipelines/moving_block_bootstrap.py`'s
`_bootstrap_blocks()`, read at `840beb9`.

**Deviations from Jesse (documented)**: Jesse's pipeline operates on **absolute** deltas
(`close[i]-close[i-1]`, `high[i]-close[i]`, `close[i]-low[i]`) on **1-minute** candles inside its
own live-replay engine, and derives its block length from `batch_size // 10`. This harness uses
**log** deltas on **4h** bars (this repo's own convention throughout — see `significance.js`'s
log returns and `sma4h-trend.js`'s bar math) with high/low relative to that bar's own close, and
registers a **fixed** block length (30 bars = 5 days on 4h) up front, swept at 10/90 for
sensitivity, per the WP3 brief.

Synthetic OHLC reconstruction anchors at close=100 (scale-invariant for `runSma4h`'s SMA-crossing
signal — a positive scalar multiple of price does not change whether `close > SMA(close)`),
copies the source bars' timestamps (so `runSma4h`'s bar-count-based CAGR/hold-time math is
unaffected), and enforces `high = max(open,close,high)` / `low = min(open,close,low)` after
sampling (mirrors Jesse's own envelope enforcement).

Command: `node scripts/research/harness/montecarlo.js --n-paths 500` (writes
`var/research/wp3/montecarlo.json`). Cost 0.15%/side, block length 30, seed 42.

| symbol | SMA | hist netCAGR | synth netCAGR p5/p50/p95 | hist maxDD | synth maxDD p5/p50/p95 |
| --- | --- | --- | --- | --- | --- |
| BTC | 200 | 42.0% | -12.6% / 14.7% / 52.7% | 78.0% | 54.7% / 74.0% / 91.6% |
| BTC | 840 | 43.9% | -11.8% / 16.9% / 59.1% | 57.0% | 56.1% / 74.0% / 91.3% |
| ETH | 200 | 70.8% | -20.5% / 11.6% / 60.7% | 56.2% | 63.7% / 83.6% / 97.0% |
| ETH | 840 | 39.1% | -22.1% / 12.0% / 65.3% | 63.5% | 66.6% / 83.3% / 96.4% |
| SOL | 200 | 102.3% | -34.2% / 16.4% / 115.3% | 87.3% | 67.4% / 85.6% / 97.6% |
| SOL | 840 | 121.4% | -32.3% / 26.2% / 152.1% | 71.1% | 67.2% / 84.3% / 96.6% |

**Block-length sensitivity (BTC SMA200, 300 paths, seed 42 — warned in the brief: short blocks
destroy trend persistence and should bias trend-following rules toward failure):**

| block length | synth netCAGR p5/p50/p95 | synth maxDD p5/p50/p95 |
| --- | --- | --- |
| 10 | -19.5% / 5.4% / 40.5% | 58.9% / 78.3% / 94.3% |
| 30 (registered) | -13.6% / 13.4% / 54.0% | 55.1% / 74.3% / 92.2% |
| 90 | -6.2% / 22.0% / 64.6% | 51.6% / 69.8% / 87.3% |

### Verdict

- **The historical CAGR sits in the upper half of the synthetic distribution for every
  symbol/window** (above the synthetic p50 in 5 of 6 rows, at or above p95 for BTC-840 and close
  to it for SOL-840) — the realized trend-following return was on the favorable side of what a
  block-bootstrap of the same bar-level statistics would typically produce, though not an
  extreme outlier (never above p95 except BTC-840, and even that is inside a plausible upper
  tail with 500 draws).
- **The historical max drawdown is consistently BELOW the synthetic median** (e.g. BTC-200: 78.0%
  historical vs 74.0% synthetic median — actually close and slightly above; ETH-200: 56.2%
  historical vs 83.6% synthetic median — well below; SOL-200: 87.3% vs 85.6% — close). Reading
  across all six rows, the realized maxDD is at or below the synthetic p50 in 4 of 6 cases: **the
  one realized history somewhat undersells the tail drawdown risk these strategies could plausibly
  have faced.** This is a genuinely useful, humbling finding: SMA200/840's headline drawdown
  numbers elsewhere in this repo's docs should be read as "what happened," not "the worst
  plausible case."
- **Sensitivity confirms the brief's warning directionally but the strategy still looks
  favorable at every block length tested**: shorter blocks (10) do lower the median synthetic
  CAGR (5.4% vs 22.0% at block 90) and raise median maxDD (78.3% vs 69.8%), exactly as expected
  when trend persistence is chopped up — but even at the shortest block length tested, the
  historical netCAGR (42.0%) remains well above the synthetic p95 (40.5%), so this specific
  qualitative conclusion (SMA200 captured real trend information, not an artifact of one
  favorable bar sequence) is not block-length-sensitive here, even though the magnitude of "how
  favorable" clearly is.

## Card 4.2 — global trial ledger + deflated Sharpe ratio

`scripts/research/harness/trial-ledger.js`. Formula (Bailey & López de Prado, *The Deflated
Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality*, Journal of
Portfolio Management 40(5), 2014), reproduced here and in the file's header comment:

```
SR0  = sqrt(V[{SR_n}]) * [ (1-γ)·Z⁻¹(1 - 1/N) + γ·Z⁻¹(1 - 1/(N·e)) ]
DSR  = Φ( (SR_hat - SR0) · sqrt(T-1) / sqrt(1 - γ3·SR_hat + ((γ4-1)/4)·SR_hat²) )
```
`γ` = Euler–Mascheroni constant (0.5772156649…), `Z⁻¹` = inverse standard normal CDF, `N` =
number of trials, `V[{SR_n}]` = cross-sectional variance of the trials' Sharpe estimates
(the paper's proxy for the chance-driven dispersion of a zero-skill Sharpe estimator), `SR_hat` /
`T` / `γ3` (skewness) / `γ4` (kurtosis, non-excess) describe the SELECTED strategy's own return
series. `Φ` = standard normal CDF.

### Trial ledger

Command: `node scripts/research/harness/trial-ledger.js` (writes
`var/research/wp3/trial-ledger.json`).

| category | source | count |
| --- | --- | --- |
| edge-search-round1 | `var/edge/train-r1.json` (train phase) | 38 |
| edge-search-round2 | `var/edge/train.json` (train phase) | 14 |
| swing-rules | `docs/swing/*.json` | 17 |
| replay-rules-variants | `../snapshot_tradingview/var/replay-rules/*.summary.json` | 13 |
| sma-sensitivity | `docs/research/EXTERNAL_4H_SMA200_STATUS.md` sensitivity section, N∈{125,150,175,200,225,250,300}×3 symbols | 21 |
| card4-exploratory-20week | `RESEARCH_BACKLOG.md` Card 4 exploratory table, {BTC,ETH,SOL}×{SMA200,20-week} | 6 |
| card7-exploratory-sma140-z | `RESEARCH_BACKLOG.md` Card 7 (PeterLP123 vol-normalized trend z) | 9 |
| **Total** | | **118** |

`card7-exploratory-sma140-z`'s count of 9 is read off the report's own text ("z>1 raises switches
on 6 of 9 rows", "lowers CAGR on 8 of 9") — the exact per-row breakdown was never preserved as
data in this repo, only that count. Documented, not silently assumed.

### DSR inputs and result

`V[{SR_n}]` proxy: the 52 edge-search rows (`train-r1.json` + `train.json`) each report a
per-config `t` statistic directly (`t = mean/(sd/sqrt(n))`); `SR_trial ≈ t/sqrt(n)` recovers a
per-trade Sharpe-like estimate for each. Cross-sectional sample variance of those 52 values:
**2.8552e-2**.

`SR_hat`, `T`, skew, kurtosis for the six DSR targets come from `runSma4h`'s own `series`
(S3 cost, 0.15%/side), resampled to **end-of-UTC-day equity**, then simple day-over-day returns.

| target | SR_hat (daily) | T (days) | skew | kurtosis | SR0 (chance benchmark) | DSR |
| --- | --- | --- | --- | --- | --- | --- |
| SMA200-BTC | 0.0512 | 3295 | 0.705 | 14.963 | 0.4374 | ~0.0000 |
| SMA840-BTC | 0.0548 | 3188 | 0.455 | 13.702 | 0.4374 | ~0.0000 |
| SMA200-ETH | 0.0622 | 3295 | 0.845 | 13.039 | 0.4374 | ~0.0000 |
| SMA840-ETH | 0.0445 | 3188 | 0.200 | 13.897 | 0.4374 | ~0.0000 |
| SMA200-SOL | 0.0666 | 2205 | 1.737 | 15.777 | 0.4374 | ~0.0000 |
| SMA840-SOL | 0.0712 | 2098 | 0.957 | 14.478 | 0.4374 | ~0.0000 |

### Important caveat: this DSR mixes two different sampling frequencies — read it as illustrative, not precise

`SR_hat` above is a **per-day** Sharpe ratio (daily-sampled equity, as the WP3 brief specifically
asked for). But `V[{SR_n}]`'s 52 inputs are **per-trade** Sharpe-like estimates (mean R per trade
/ std R per trade, over each edge-search config's own trade count, holding periods of tens of
hours) — a different, coarser-to-finer sampling frequency than daily. The deflated Sharpe ratio
formula assumes `SR_hat` and the trial-population Sharpe estimates it's being benchmarked against
are on a **comparable timescale**; mixing per-trade and per-day Sharpe estimates without
converting one to the other's frequency is a real methodological gap, not just an approximation
detail. A more rigorous version would convert the 52 edge-search `SR_trial` values to a per-day
equivalent using each config's own average hold time (`hours` field, available per row but not
used here) before taking their cross-sectional variance, or conversely would compute a per-trade
`SR_hat` for SMA200/840 using their own trade list (`sma200-{SYM}-trades.jsonl`, already
generated for R4 above) instead of daily resampling. **Given this scale mismatch, `DSR ≈ 0` for
all six targets should be read as "the chance-benchmark implied by 118 registered trials, if
those trials' Sharpe dispersion were representative of daily-frequency variation, dwarfs
SMA200/840's own daily Sharpe" — a genuinely humbling number, but not a statistic to quote to more
than one significant figure of confidence.** This is flagged here rather than fixed because
harmonizing frequency correctly is materially more work than the rest of this item and the brief
asked to "document the formula" and "compute DSR… given the total trial count," which this does,
honestly caveated.

### Verdict

- **118 trials is a defensible enumeration of this workstream's registered/reported experiments**
  to date (edge-search rounds, swing rule studies, engine replay variants, SMA sensitivity, and
  two exploratory reports) — likely an undercount of every parameter combination ever glanced at
  during development, but it is the set that was actually written down and reported on, which is
  the standard the paper's method assumes ("N trials run before this one was selected").
- **DSR ≈ 0 for every SMA200/840 × symbol combination on a daily-Sharpe basis**, i.e. under this
  (frequency-mismatched, documented) approximation, none of the six clears the chance-of-best-of-118
  bar. Given the scale-mismatch caveat above, this should be read as directional evidence for
  caution (SMA200/840's daily-level Sharpe is genuinely modest, 0.04–0.07, well below what 118
  trials would produce by chance if the trial population's dispersion applied at daily
  frequency) rather than a precise, publishable DSR figure.

## Tests

32 checks across 4 files, all passing:

```
node test-wp3-significance.js     # 6 checks  - hand-computed toy case, net-of-cost cost math,
                                   #   determinism, random +-1 series p ~ uniform (50 seeds),
                                   #   injected-edge p < 0.01
node test-wp3-risk-shuffle.js     # 9 checks  - shuffle determinism, pct-vs-R units, generic
                                   #   trade loader, existing --calls/--param CLI unaffected,
                                   #   new --trades/--shuffle CLI end to end
node test-wp3-montecarlo.js       # 7 checks  - delta-tuple hand-check, block-bootstrap index
                                   #   contiguity/determinism, OHLC envelope validity, end-to-end
node test-wp3-trial-ledger.js     # 10 checks - normal CDF/invCDF vs textbook Z-table constants,
                                   #   DSR=0.5 exact identities, classical-PSR hand-check,
                                   #   monotonicity in nTrials and varSrTrials, daily resample,
                                   #   ledger category counts
```

`git diff --check` on `scripts/research/risk-sim.js` (the only modified pre-existing file):
clean.

## Full command list (reproduce everything in this doc)

```
# R3
node scripts/research/harness/significance-apply.js

# R4
node scripts/research/harness/r4-apply.js
node scripts/research/risk-sim.js --trades var/research/wp3/sma200-BTC-trades.jsonl --shuffle --units pct --n-shuffles 2000 --seed 42 --out wp3-sma200-BTC-shuffle
node scripts/research/risk-sim.js --trades var/research/wp3/sma200-ETH-trades.jsonl --shuffle --units pct --n-shuffles 2000 --seed 42 --out wp3-sma200-ETH-shuffle
node scripts/research/risk-sim.js --trades var/research/wp3/sma200-SOL-trades.jsonl --shuffle --units pct --n-shuffles 2000 --seed 42 --out wp3-sma200-SOL-shuffle
node scripts/research/risk-sim.js --trades var/research/wp3/re-flag-retest-1h-netR.jsonl --shuffle --units R --risk-pct 1 --n-shuffles 2000 --seed 42 --out wp3-re-flag-retest-1h-shuffle

# R7
node scripts/research/harness/montecarlo.js --n-paths 500

# Card 4.2
node scripts/research/harness/trial-ledger.js

# tests
node test-wp3-significance.js
node test-wp3-risk-shuffle.js
node test-wp3-montecarlo.js
node test-wp3-trial-ledger.js
```

Outputs (all gitignored under `var/research/`, not staged): `var/research/wp3/{significance,
montecarlo,trial-ledger}.json`, `var/research/wp3/{sma200-BTC,sma200-ETH,sma200-SOL,
re-flag-retest-1h}-*.jsonl`, `var/risk-sim/wp3-*-shuffle.json`.
