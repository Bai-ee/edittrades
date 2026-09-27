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

TODO: filled in after `fetch-4h-long.js` runs — per-symbol candle counts, first/last
timestamps, gap counts, sha256 per file (see `var/edge/4h-long/manifest.json`).

## Commands

TODO: filled in after the run (see `var/research/external-4h-sma200/commands.txt`).

## Test results

TODO: filled in after `npm run test:sma4h`.

## Results

TODO: filled in after the backtest runs — BTC/ETH/SOL tables (both windows, all cost
scenarios), sensitivity, regime breakdown, attribution, EMA20 overlap, and 5 dated examples
(biggest avoided drawdown, biggest captured trend, worst whipsaw cluster, costliest late
entry, costliest late exit).

## Decision

Decision: pending orchestrator review.
