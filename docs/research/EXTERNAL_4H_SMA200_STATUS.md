# External 4H SMA200 study (research only)

Research only. No engine, config, payload or deploy change. Code: `scripts/research/edge/`.
Outputs: `var/edge/4h-long/`, `var/research/external-4h-sma200/` (both untracked; `var/research/`
is gitignored, `var/edge/` is not ignored but is deliberately never staged).

- Branch: `edge-external-4h-sma200`
- Base: `bd01c2f` (`bd01c2fc934b8fe35475d371fb233fa673a67d80`, 2026-09-27)
- Worktree: `/Users/bballi/Documents/Repos/snapshot_tradingview-edge-sma200`
- External reference: `0xrikt/crypto-skills` @ `360c5e24d6ee689f21491771781dbd70ba2034e9`
  (semantics to be filled in by orchestrator — see "External implementation check" below)

## Registration (written before results)

This section is frozen before the backtest is run or any result is inspected, so the strategy
and evaluation plan cannot drift toward whatever looks good in hindsight.

### Strategy EXTERNAL_4H_SMA200_V1 (frozen — not tuned after this point)

- Bars: 4H, spot (Binance BTCUSDT/ETHUSDT/SOLUSDT).
- Signal: at the close of bar `i` (fully closed), `want = close[i] > SMA200(close)[i]` (the
  SMA window includes bar `i`). `close[i] <= SMA200[i]` → flat. No shorts, no stops, no take
  profit.
- Execution: fill at the **open of bar `i+1`** (next-event fill, not next-close). Single
  position; staying above the SMA does not re-buy (one entry per crossing).
- Equity mark: every 4H bar, close-to-close while continuously held. The bar in which a
  position is opened marks `close[i+1]/open[i+1]`; the bar in which it is closed marks
  `open[i+1]/close[i]` and then goes flat for the remainder of that bar.
- Warm-up: the first `N` bars (default `N=200`) are excluded from all performance stats.
- N is swept only in the clearly-labelled SENSITIVITY section; the baseline is N=200 and is
  not tuned to the data.

### Cost scenarios (per side, on notional)

| ID | Description | Switch cost/side | Borrow |
| --- | --- | --- | --- |
| S1 | Frictionless | 0% | 0 |
| S2 | Spot, exchange fee only | 0.10% | 0 |
| S3 | EditTrades spot model (0.10% swap + 0.05% slippage — same components `spot-trend.js` charges per switch) | 0.15% | 0 |
| S4a | Perp proxy: legacy EditTrades flat round-trip long (34 bps ⇒ 0.17%/side) + static borrow 0.01%/h on time in position | 0.17% | 0.01%/h |
| S4b | Perp proxy: same 0.17%/side + static borrow 0.024%/h on time in position | 0.17% | 0.024%/h |

S4a/S4b are **labelled static scenarios**, not historical funding — Jupiter perps charge
hourly borrow on position size, not a funding rate, so this is a stress-test proxy, not a
claim about what a perp position would actually have paid historically.

### Date windows

- **(a) Per-symbol full history after warm-up**: each symbol's own data from bar `N` to now.
- **(b) COMMON window**: SOL's warm-up-eligible start (first bar with a valid decision, ≈
  2020-08-11 + `N`×4h) through the common end (now), applied identically to BTC/ETH/SOL so
  all three are compared over the same calendar span. Bars before the window are still used
  to compute the running signal/position state (so the strategy isn't artificially reset to
  flat mid-trend at the window boundary); only the reported equity curve and stats are
  re-based to 1.0 at the window's first bar.

Both windows are reported, clearly labelled.

### Other reported cuts (frozen scope, not new strategies)

- **B&H baseline (Baseline A)**: buy-and-hold over the identical dates — CAGR, Sharpe, max DD,
  per-year.
- **Baseline C**: existing EditTrades daily EMA20 spot filter (`runFilter` from
  `scripts/research/edge/spot-trend.js`, unmodified) run on `var/edge/daily-long` over the same
  date range, plus a daily overlap table (both long / SMA4h-only / EMA20-only / both flat, with
  forward 1-day B&H mean return per group).
- **Attribution**: B&H log return split into bars where the strategy is long ("captured while
  long") vs flat ("avoided while flat" — negative avoided-return bars are losses avoided).
- **Regime breakdown**: trailing-90-day (540-bar) B&H return buckets (>+30% strong bull,
  0–30% moderate bull, −20–0% sideways, < −20% bear — trailing only, no future leakage), and
  trailing-30-day (180-bar) realized-vol terciles (cut points computed on the full sample,
  descriptive labels only). Strategy vs B&H mean 4h return and exposure per bucket.
- **Sensitivity** (post-baseline, always labelled `SENSITIVITY`, informational only — the
  frozen strategy stays N=200): N ∈ {125, 150, 175, 200, 225, 250, 300} at S3.

### What this study does NOT do

- No shorting, no stop loss, no take profit, no leverage.
- No parameter fit to this dataset — N=200 is fixed before results are seen; the N-sweep is
  reported as sensitivity, not used to pick a "better" N.
- No claim about live Jupiter perp funding history — S4 borrow is a static per-hour stress
  scenario.

## External implementation check

TODO (orchestrator): compare this implementation against `0xrikt/crypto-skills` @
`360c5e24d6ee689f21491771781dbd70ba2034e9` once that repo's SMA200 strategy semantics are
available in this environment (signal timing, fill rule, warm-up handling, cost model) and
note any divergence here.

## Datasets

Binance spot klines, native interval (no derivation from 1m), fetched via
`scripts/research/edge/fetch-4h-long.js` (host fallback `api.binance.com` ->
`data-api.binance.vision`, same pattern as `scripts/research/capture-binance-1m.js`). Both
directories are local-only (`var/edge/` is not gitignored but is deliberately never staged).

### `var/edge/4h-long/` (4H, the study's own bars)

| file | candles | from | closed through | gaps (count / largest) | validation | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| BTC_4h.json | 19955 | 2017-08-17T04:00Z | 2026-09-27T16:00Z | 8 / 7 candles (largest gap after 2018-02-08T00:00Z) | ok | `26220ca1d4c0892d229300f076ad0d15355fba1118581c4f7d1b71435f3e56fb` |
| ETH_4h.json | 19955 | 2017-08-17T04:00Z | 2026-09-27T16:00Z | 8 / 7 candles (same gap window) | ok | `e5881c244b72b3551d50c69979170faed82a3158124cedcf282df91e1b901e8d` |
| SOL_4h.json | 13431 | 2020-08-11T04:00Z | 2026-09-27T16:00Z | 0 / 0 | ok | `21461a5e9c5ee2f50a3f0dd4349167fde30f0447f53a6569147d2449783d5e53` |

BTC/ETH's 8 gaps (largest 7 missing 4h candles, clustered around 2018-02-08) are real holes in
Binance's earliest klines history, not a fetch bug — same window is a known thin-data period in
other studies in this repo. All candles pass the OHLC envelope check (finite positive
open/high/low/close, `high >= max(open,close)`, `low <= min(open,close)`), monotone unique
timestamps. Full detail: `var/edge/4h-long/manifest.json`.

### `var/edge/daily-long/` (1D, rebuilt for Baseline C — this worktree had no committed copy)

| file | candles | from | closed through | gaps | sha256 |
| --- | --- | --- | --- | --- | --- |
| BTC_1d.json | 3328 | 2017-08-17 | 2026-09-27 | 0 | `1c49ddec613678bc9fc987fc0e4dfa92b6283ad11e8328fe85826d9eb949664e` |
| ETH_1d.json | 3328 | 2017-08-17 | 2026-09-27 | 0 | `f901ba1e4f7fa99a78b68a405713f669e3921fefaa7303b206d9941a677707f2` |
| SOL_1d.json | 2238 | 2020-08-11 | 2026-09-27 | 0 | `8654f28cc8bc22c193c724bcb5a65ad839b7e371d7edb941a7223805601829da` |

## Commands

```
node scripts/research/edge/fetch-4h-long.js --symbols BTC,ETH,SOL --interval 4h --out var/edge/4h-long
node scripts/research/edge/fetch-4h-long.js --symbols BTC,ETH,SOL --interval 1d --out var/edge/daily-long
node scripts/research/edge/sma4h-trend.js --out var/research/external-4h-sma200
npm run test:sma4h
```

Outputs: `var/research/external-4h-sma200/{summary.json,trades.jsonl,equity.csv,REPORT.md,charts.html,commands.txt}`.

## Test results

`npm run test:sma4h` (`test-sma4h-trend.js`) — 6/6 checks passed:

- (i) appending future bars, including a huge price spike, does not change any prior
  decision/position/equity value (byte-identical `series` prefix).
- (ii) mutating bar i's close only changes fills from bar i+1 onward; bar i's own return is
  unaffected when bar i is an exit bar (its return formula uses `open[i]`/`close[i-1]`, not
  `close[i]`).
- (iii) hand-computed N=3, 10-bar fixture: exact entries (2), exits (1), per-bar net/B&H
  equity path, max DD (8/15), trade P&L (-30%), and confirms cost-per-side is applied exactly
  once per switch (`(1-cost)` and `(1-cost)^2` factors verified against a zero-cost control run).
- (iv) fewer bars than N produces zero trades.
- (v) a monotonically rising price series (SMA always lagging) yields exactly one entry and
  zero exits, however long the series runs.

`node test-swing-rules.js` (unrelated sanity check, unaffected by this study): 12/12 checks
passed (2 sections skip — missing `deep60` fixture, pre-existing, unrelated to this change).

`git diff --check`: clean (no whitespace errors) on the files this study touched.

## Results

N=200. Full numbers: `var/research/external-4h-sma200/{REPORT.md,summary.json}`. Reproduced
here for durability.

### BTC — a_full_history (2017-08-17 -> now)

| scenario | net CAGR | gross CAGR | cost drag | B&H CAGR | Sharpe | Sortino | maxDD | B&H maxDD | Calmar | entries | exposure | avg hold(d) | turnover/yr | win% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 frictionless | 55.65% | 55.65% | 0.00% | 40.35% | 1.19 | 1.74 | 75.07% | 83.91% | 0.74 | 277 | 52.77% | 6.1 | 61.3 | 15.58% |
| S2 spot fee 0.10% | 46.39% | 55.65% | 9.26% | 40.35% | 1.06 | 1.54 | 77.03% | 83.91% | 0.60 | 277 | 52.77% | 6.1 | 61.3 | 14.13% |
| S3 EditTrades spot 0.15% | 41.97% | 55.65% | 13.68% | 40.35% | 0.99 | 1.44 | 77.96% | 83.91% | 0.54 | 277 | 52.77% | 6.1 | 61.3 | 13.04% |
| S4a perp proxy, borrow 0.01%/h | -11.68% | 55.65% | 67.33% | 40.35% | -0.04 | -0.06 | 91.89% | 83.91% | -0.13 | 277 | 52.77% | 6.1 | 61.3 | 9.06% |
| S4b perp proxy, borrow 0.024%/h | -53.78% | 55.65% | 109.44% | 40.35% | -1.45 | -2.02 | 99.96% | 83.91% | -0.54 | 277 | 52.77% | 6.1 | 61.3 | 4.35% |

### BTC — b_common_window (SOL-eligible start -> now)

| scenario | net CAGR | gross CAGR | cost drag | B&H CAGR | Sharpe | maxDD | B&H maxDD | entries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | 53.90% | 53.90% | 0.00% | 41.61% | 1.28 | 44.38% | 77.04% | 277 |
| S2 | 44.54% | 53.90% | 9.36% | 41.61% | 1.13 | 45.48% | 77.04% | 277 |
| S3 | 40.07% | 53.90% | 13.83% | 41.61% | 1.05 | 46.02% | 77.04% | 277 |
| S4a | -13.01% | 53.90% | 66.91% | 41.61% | -0.15 | 86.78% | 77.04% | 277 |
| S4b | -54.57% | 53.90% | 108.47% | 41.61% | -1.79 | 99.59% | 77.04% | 277 |

### ETH — a_full_history

| scenario | net CAGR | gross CAGR | cost drag | B&H CAGR | Sharpe | Sortino | maxDD | B&H maxDD | Calmar | entries | exposure | avg hold(d) | win% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | 85.07% | 85.07% | 0.00% | 28.06% | 1.35 | 1.98 | 52.23% | 94.08% | 1.63 | 242 | 50.59% | 6.7 | 18.26% |
| S2 | 75.42% | 85.07% | 9.65% | 28.06% | 1.26 | 1.84 | 54.88% | 94.08% | 1.37 | 242 | 50.59% | 6.7 | 17.43% |
| S3 | 70.78% | 85.07% | 14.29% | 28.06% | 1.21 | 1.77 | 56.15% | 94.08% | 1.26 | 242 | 50.59% | 6.7 | 17.01% |
| S4a | 8.46% | 85.07% | 76.61% | 28.06% | 0.43 | 0.62 | 83.35% | 94.08% | 0.10 | 242 | 50.59% | 6.7 | 12.03% |
| S4b | -41.70% | 85.07% | 126.78% | 28.06% | -0.64 | -0.90 | 99.66% | 94.08% | -0.42 | 242 | 50.59% | 6.7 | 6.22% |

### ETH — b_common_window

| scenario | net CAGR | B&H CAGR | Sharpe | maxDD | B&H maxDD | entries |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 76.15% | 38.74% | 1.36 | 39.74% | 81.12% | 242 |
| S2 | 67.08% | 38.74% | 1.25 | 42.96% | 81.12% | 242 |
| S3 | 62.72% | 38.74% | 1.20 | 44.51% | 81.12% | 242 |
| S4a | 3.45% | 38.74% | 0.32 | 83.35% | 81.12% | 242 |
| S4b | -44.33% | 38.74% | -0.88 | 99.09% | 81.12% | 242 |

### SOL — a_full_history (2020-08-11 -> now)

| scenario | net CAGR | gross CAGR | cost drag | B&H CAGR | Sharpe | Sortino | maxDD | B&H maxDD | Calmar | entries | exposure | avg hold(d) | win% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | 125.29% | 125.29% | 0.00% | 82.95% | 1.39 | 2.20 | 83.23% | 96.60% | 1.51 | 217 | 49.44% | 4.9 | 15.28% |
| S2 | 109.70% | 125.29% | 15.59% | 82.95% | 1.30 | 2.06 | 86.06% | 96.60% | 1.27 | 217 | 49.44% | 4.9 | 15.28% |
| S3 | 102.31% | 125.29% | 22.98% | 82.95% | 1.26 | 1.99 | 87.30% | 96.60% | 1.17 | 217 | 49.44% | 4.9 | 15.28% |
| S4a | 29.31% | 125.29% | 95.98% | 82.95% | 0.72 | 1.12 | 93.08% | 96.60% | 0.31 | 217 | 49.44% | 4.9 | 10.19% |
| S4b | -29.51% | 125.29% | 154.80% | 82.95% | -0.02 | -0.03 | 99.49% | 96.60% | -0.30 | 217 | 49.44% | 4.9 | 4.17% |

SOL's `b_common_window` == `a_full_history` numerically: SOL's own eligible start (its
listing + N×4h) is what defines the common window, so it's unchanged by definition.

### Sensitivity (SENSITIVITY — S3, full history, N is NOT selected on)

| N | BTC net CAGR | BTC Sharpe | BTC maxDD | BTC trades | ETH net CAGR | SOL net CAGR |
| --- | --- | --- | --- | --- | --- | --- |
| 125 | 45.66% | 1.06 | 60.35% | 346 | 56.34% | 100.28% |
| 150 | 44.29% | 1.04 | 59.19% | 337 | 69.46% | 103.78% |
| 175 | 47.44% | 1.08 | 71.89% | 274 | 74.79% | 105.90% |
| 200 (frozen) | 41.97% | 0.99 | 77.96% | 277 | 70.78% | 102.31% |
| 225 | 50.05% | 1.11 | 78.97% | 241 | 70.96% | 115.06% |
| 250 | 57.58% | 1.21 | 73.85% | 221 | 63.80% | 116.21% |
| 300 | 57.65% | 1.21 | 70.58% | 192 | 57.73% | 123.74% |

N=200 is not a local optimum on any symbol — CAGR is fairly flat/noisy across the sweep,
which reads as an argument against having curve-fit N, not for switching to a different N.

### Attribution (Q9, S3) — B&H log return captured while long vs avoided while flat

| symbol | window | captured (long) | avoided (flat) | total B&H log return |
| --- | --- | --- | --- | --- |
| BTC | full history | 4.0014 (+5368% equiv.) | -0.9426 (-61.0% equiv.) | 3.0588 |
| BTC | common window | 2.6052 | -0.4991 | 2.1061 |
| ETH | full history | 5.5459 | -3.3185 | 2.2274 |
| ETH | common window | 3.4208 | -1.4117 | 2.0091 |
| SOL | full history | 4.9212 | -1.2442 | 3.6770 |
| SOL | common window | 4.9212 | -1.2442 | 3.6770 |

Reading: being flat consistently avoided negative-log-return periods (loss avoidance is real
on all three symbols/windows), but the strategy also missed a meaningful share of the total
B&H log return by not capturing 100% of the up-moves (it isn't long 100% of the time, and
entries/exits lag the SMA).

### Regime breakdown (S3, full history) — trailing 90d B&H return buckets

| symbol | regime | n bars | exposure | strat mean 4h ret | B&H mean 4h ret |
| --- | --- | --- | --- | --- | --- |
| BTC | strong bull (>+30%/90d) | 5311 | 76.99% | 0.0646% | 0.1020% |
| BTC | moderate bull (0..30%/90d) | 5190 | 57.21% | 0.0194% | 0.0301% |
| BTC | sideways (-20..0%/90d) | 4803 | 44.39% | 0.0004% | 0.0085% |
| BTC | bear (<-20%/90d) | 4111 | 23.16% | -0.0178% | -0.0707% |
| ETH | strong bull | 6373 | 72.04% | 0.0744% | 0.1091% |
| ETH | moderate bull | 4086 | 49.44% | 0.0391% | 0.0240% |
| ETH | sideways | 3350 | 43.88% | 0.0167% | 0.0147% |
| ETH | bear | 5606 | 31.34% | -0.0062% | -0.0571% |
| SOL | strong bull | 4370 | 75.58% | 0.1316% | 0.2005% |
| SOL | moderate bull | 2331 | 50.24% | 0.0250% | 0.0279% |
| SOL | sideways | 1993 | 41.65% | 0.0430% | 0.0352% |
| SOL | bear | 4197 | 29.24% | -0.0200% | -0.0560% |

Exposure tracks the regime monotonically on all three symbols (highest exposure in strong
bull, lowest in bear) — the filter is doing what a trend filter is supposed to do. Strategy
mean-return is positive in bull regimes and negative (less negative than B&H) in bear.

Trailing 30d realized-vol terciles (S3, full history, cut points from the full sample):

| symbol | T1 low vol strat / B&H | T2 mid vol strat / B&H | T3 high vol strat / B&H |
| --- | --- | --- | --- |
| BTC | 0.0396% / 0.0366% | -0.0006% / -0.0106% | 0.0234% / 0.0510% |
| ETH | 0.0344% / 0.0334% | 0.0241% / 0.0100% | 0.0379% / 0.0388% |
| SOL | 0.0140% / 0.0114% | 0.0259% / 0.0277% | 0.1029% / 0.1326% |

No clean monotonic pattern strategy-vs-vol here; T2 (mid vol) is the weakest bucket for
BTC/ETH, consistent with "chop" being where a trend filter loses relative to B&H.

### Baseline C — daily EMA20 spot filter (`runFilter`, unmodified `spot-trend.js`)

| symbol | window | CAGR | B&H CAGR | maxDD | B&H maxDD | Sharpe | exposure | trades | win% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | full history | 41.99% | 38.66% | 60.47% | 83.19% | 1.00 | 52.69% | 182 | 25.82% |
| BTC | common window | 29.84% | 41.61% | 60.47% | 76.63% | 0.85 | 53.36% | 121 | 22.31% |
| ETH | full history | 56.32% | 26.86% | 55.62% | 93.97% | 1.05 | 49.09% | 187 | 25.13% |
| ETH | common window | 54.42% | 39.17% | 54.83% | 79.30% | 1.07 | 49.55% | 119 | 26.89% |
| SOL | full history | 99.32% | 72.43% | 64.76% | 96.27% | 1.25 | 49.41% | 135 | 23.70% |
| SOL | common window | 113.41% | 82.04% | 64.76% | 96.27% | 1.34 | 49.46% | 133 | 24.06% |

At S3 cost, the 4H SMA200 filter and the daily EMA20 filter land in a similar CAGR/Sharpe
range on BTC; EMA20 daily is notably better on ETH (fewer, longer trades: 182-187 vs 217-277
switches) and roughly comparable-to-worse on SOL depending on window.

### Daily overlap: SMA4h(200) vs daily EMA20 (full history, S3 series)

| symbol | both long | SMA4h-only | EMA20-only | both flat |
| --- | --- | --- | --- | --- |
| BTC | 1597d (48.5%), fwd +0.298%/d | 142d (4.3%), fwd +0.171%/d | 144d (4.4%), fwd -0.032%/d | 1411d (42.8%), fwd +0.009%/d |
| ETH | 1491d (45.3%), fwd +0.422%/d | 161d (4.9%), fwd +0.053%/d | 130d (4.0%), fwd +0.016%/d | 1512d (45.9%), fwd -0.053%/d |
| SOL | 992d (45.0%), fwd +0.696%/d | 103d (4.7%), fwd +0.148%/d | 98d (4.5%), fwd -0.037%/d | 1011d (45.9%), fwd +0.032%/d |

The two filters agree (both-long or both-flat) on ~90% of days across all three symbols. On
the days they disagree, "SMA4h-only" days still had positive forward B&H return on all three
symbols (SMA4h caught something EMA20 missed); "EMA20-only" days had negative or flat forward
return on BTC/ETH and negative on SOL (EMA20 was long when SMA4h had already flattened, and
that turned out to be the better call on those specific days).

### 5 concrete examples (BTC, S3, full history — dates from `trades.jsonl`)

1. **Biggest avoided drawdown.** B&H peaked $15,210 on 2018-01-09, bottomed $6,043 on
   2018-02-06 (-60.3%). The strategy had exited on 2018-01-08 (one day before the peak) and
   stayed flat through the entire crash, not re-entering until 2018-02-17.
2. **Biggest captured trend.** Entry 2019-02-08 @ $3,668.28 -> exit 2019-06-09 @ $7,718.92,
   held 120.3 days, net trade return (S3) +109.8%.
3. **Worst whipsaw cluster.** 14 entries within a 60-day span, 2020-05-25 -> 2020-07-21
   (13 of the first 13 round trips were losses of roughly 0.5-2.4% each, chopping through
   COVID-recovery consolidation, before the 14th entry on 2020-07-21 caught a real breakout
   and returned +20.9%).
4. **Costliest late entry.** After the 2018-01-09 -> 2018-02-06 crash (see #1), price
   bottomed at $6,043 but the strategy didn't re-enter until 2018-02-17 @ $10,459 — missing
   73.1% of the rebound off the bottom — and that specific re-entry was itself a false start,
   exiting 2018-02-22 @ $9,972 for a -4.9% loss.
5. **Costliest late exit.** Entry 2017-11-13 @ $6,200.14; price ran to $19,709.50 by
   2017-12-17, but the SMA200 cross-down didn't confirm until 2017-12-22 @ $12,726.45 — giving
   back 35.4% from the trade's peak before exiting (the trade still finished +104.6% net, just
   well short of its peak).

## Decision

Decision: pending orchestrator review.
