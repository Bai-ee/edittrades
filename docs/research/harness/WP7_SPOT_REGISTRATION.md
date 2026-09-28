# WP7 — spot trend arm evidence: frozen registration (2026-09-27)

Research only. Written and frozen **before** any of the item 1–5 backtests below are run or
inspected, so none of it can drift toward whatever looks good in hindsight. Anything not in
this document (extra cuts, extra parameter values, alternate windows) that shows up in
`WP7_SPOT.md` is explicitly labelled `EXPLORATORY`, is not used for the arm verdicts, and
counts as a trial for Card 4.2's multiple-testing ledger.

Builds on the frozen registration in `docs/research/EXTERNAL_4H_SMA200_STATUS.md` (Card 1) —
same data, same cost model, same window methodology. Does not re-litigate Card 1's own
verdict (PAPER CANDIDATE spot, REJECT perps); this WP only adds the items listed in the WP7
work order.

## Scope (from the WP7 work order)

1. Registered slow-trend variants (Card 1.6/4.4).
2. Card 4.1 DCA benchmark (plain DCA vs DCA-into-filter).
3. Card 7.1 Trend Atlas vol-target + no-trade-buffer sizing overlay.
4. Card 1.7 equal-weight BTC/ETH/SOL portfolio.
5. Break-even per-side cost vs B&H for every registered arm.

Headline question: **does any arm beat plain weekly DCA?**

## Data (reused, not refetched)

`var/edge/4h-long/{BTC,ETH,SOL}_4h.json` and `var/edge/daily-long/{BTC,ETH,SOL}_1d.json` —
Binance spot klines, already fetched and manifest-validated for Card 1 (see
`EXTERNAL_4H_SMA200_STATUS.md` §Datasets). Not refetched here; same sha256 manifests apply.

## Cost model (frozen, no exceptions)

- Spot: **0.15% per side** on every executed change, including rebalances and DCA buys/sells
  ("Spot cost 0.15%/side on every executed change incl. rebalances" — common rules). This is
  identical to `S3_edittrades_spot` in Card 1 and to `spot-trend.js`'s hardcoded `SWITCH_COST`.
- Cash yield: **zero**. Uncontributed/uninvested cash in the DCA arms earns nothing while it
  waits (matches "zero cash yield" in the common rules).
- Gross (0% cost) is also reported per arm, only to compute break-even (item 5) — it is not a
  claimed live scenario.
- No borrow anywhere in WP7 (spot only; perps carry is out of scope per Card 6/1).

## Registered strategies

All four use the **same decision-then-next-open-fill convention** as Card 1: the signal is
evaluated on a bar's *closed* value, and any position change is filled at the **next** bar's
open. Position is single long/flat (no shorts, no leverage, no pyramiding).

| ID | Bars | Rule | Implementation |
| --- | --- | --- | --- |
| `SMA200_4H` (comparator, = Card 1) | 4H | long while close > SMA200(close) | `runSma4h(bars4h, {n:200,...})` — **existing function, called, not modified** |
| `SLOW_SMA840_4H_V1` (Card 1.6/4.4) | 4H | long while close > SMA840(close) (≈ 20-week SMA, matches Card 4's exploratory "20-week" rule) | `runSma4h(bars4h, {n:840,...})` — **existing function, called, not modified** |
| `DONCHIAN_4W_V1` (Card 1.6/4.4) | 1D | long when close > highest **high** of the prior 28 days (excludes the current day); flat when close < lowest **low** of the prior 28 days; otherwise **hold the current state** (classic Donchian/Turtle channel, not a fresh decision every bar) | new `donchianWantSeries()` in `wp7-engine.js`, backtested by new `runBinaryFilter()`, reusing the existing, unmodified `donchian(bars, n)` helper from `lib.js` for the channel itself |
| `EMA20_DAILY` (comparator, = live tracker rule) | 1D | long while close > EMA20(close) | **two views, both used, cross-checked against each other**: (a) headline aggregate numbers at the fixed 0.15% cost come from the existing `runFilter()` in `spot-trend.js`, called unmodified; (b) DCA/vol-overlay/portfolio/break-even need a per-bar position series and a variable cost, which `runFilter()` does not expose, so a parity reimplementation (`emaWantSeries()` + `runBinaryFilter()`, same EMA formula from `lib.js`) is used and its aggregate output is checked against (a) before being trusted |

`28` (≈4 weeks) and `840` (≈20 weeks at 6 bars/day) are fixed before any result is seen — not
swept or tuned on this data. `200` and `20` are Card 1's and the live tracker's existing,
already-frozen numbers, reused as comparators only.

## Windows (all four strategies, all reported, clearly labelled)

- **(a) Full per-symbol history**: each symbol's own data from its first valid decision bar to
  now (same eligibility rule as Card 1: first bar with a finite indicator value).
- **(b) Common window**: SOL's warm-up-eligible start through now, applied identically to
  BTC/ETH/SOL, exactly as in Card 1 — bars before the window still feed the running
  signal/position state; only the reported equity curve and stats are re-based to 1.0 at the
  window's first bar. Computed once per strategy (each strategy has its own eligible start,
  since SMA840/Donchian28/EMA20/SMA200 warm up over different spans).
- **(c) 2020–2023 vs 2024–2026 split**: boundary `2024-01-01T00:00:00Z`, matching Card 4's
  exploratory table. Used only for the registered-variant comparison (item 1) and the
  break-even table (item 5), to see whether an arm's edge or its cost headroom held up
  out-of-sample. Not used to pick a variant — both halves are reported for every arm.

DCA (item 2) and the portfolio (item 4) use **(a) full per-symbol / common** only — a
contribution-funded position is inherently about total accumulated capital over the longest
available run, and splitting it into two non-contiguous four-year halves would double-count
or drop contributions arbitrarily. This choice is stated here, before running, specifically so
it cannot look like it was picked after seeing which half is more flattering.

## Item 2 — DCA benchmark (Card 4.1)

- Contribution: **$100, every Monday, 00:00 UTC** (the first bar of the UTC week, on both the
  4H and 1D bar grids — a 4H grid's Monday-00:00 bar is used so the same rule works on both
  frequencies without double-contributing).
- Arm (a) **plain DCA buy-and-hold**: every contribution is bought immediately (at that bar's
  open), never sold. One cost event per contribution (0.15% of $100 ≈ $0.15/week).
- Arm (b) **DCA-into-filter**: contributions accumulate as zero-yield cash. Whenever the
  filter's position is "long" for a bar and cash is nonzero, **all** cash is deployed into the
  coin at that bar's open, paying 0.15%. Whenever the filter flips to "flat", the **entire**
  coin position is sold to cash at that bar's open, paying 0.15%. Every contribution that
  arrives while already long is bought the same week (also paying 0.15%, per bar contribution)
  — "costs on every executed change" is taken literally, including small weekly top-ups.
- Applied to all four strategies in the table above (SMA200 4h, SMA840 4h, Donchian28 1D,
  EMA20 1D).
- Reported per symbol, full history and common window: **final value, total contributed,
  money-weighted return (IRR, via bisection on the standard NPV-of-cashflows equation, weekly
  contributions as outflows + terminal value as one inflow), max drawdown of account value**
  (peak-to-trough of total cash+coin value — noted caveat: ongoing contributions can mask a
  price drawdown in this metric; it is reported as specified, not corrected for it), **and cost
  paid** (sum of all per-trade fees, dollars and as % of total contributed).
- Headline comparison: arm (b) vs arm (a) on the **same IRR metric** — this is the number that
  answers "does the filter help a DCA investor, net of its own costs?", independent of lump-sum
  B&H (a different, contribution-blind baseline already covered by Card 1).

## Item 3 — vol-target + no-trade-buffer overlay (Card 7.1)

### External reference (read, not run)

`0xpg/crypto-trend-following`, pinned at `4aaa229f5bc9f1b762ba4f6ba5d83c9f5cfef294`
(`main`, MIT licence, `gh api repos/0xpg/crypto-trend-following/commits/HEAD` on 2026-09-27).
File `engine.py`:

- Risk targeting: `vol_target_annual: float = 0.20` (L67), portfolio ex-ante vol computed from
  a correlation matrix across the whole traded universe, multiplier
  `mult = vol_target_annual / ex_ante` (L619–621).
- No-trade buffer: `buffer: float = 0.10` (L78); band tolerance
  `tol = buffer * mult * equity / vol` (L637–638); the position only moves the excess **beyond**
  the band, not a full snap to target (`gap - sign(gap) * tol`, L639–645) — a "trade to the
  band edge" rule, not a binary "rebalance or don't."

### What is actually reimplemented here (per the WP7 work order, not a port of the above)

- `target_weight = min(1, targetVol / realizedVol)` while the underlying binary filter is long,
  else `0`. `realizedVol` = trailing 20-day annualized (×√365) realized volatility of daily log
  returns — same formula already used by the live tracker (`scripts/tracker/spot-trend.js`
  `VOL_TARGET`/`realizedVol`) and by `spot-portfolio.js`'s `portfolioSeries`.
- No-trade buffer: **full snap to target** the moment `|target − current| > buffer`, otherwise
  **no change at all** (not the source's partial move-to-band-edge). This is the simpler rule
  the WP7 work order specifies; the source's band-edge variant is cited above for the record,
  not implemented, per the "reimplement, don't port" instruction.
- Parameters: `targetVol = 40%`, `buffer = 0.10`.
  - `buffer = 0.10` matches the source's own default (L78) — a genuine coincidence with the
    registered default, not a copy; used because it is both.
  - `targetVol = 40%` is the **registered default** (matches the existing live tracker's
    `VOL_TARGET`), used instead of the source's `0.20`, because the source's number is a
    **portfolio-level** target across a diversified multi-instrument futures book (its ex-ante
    vol comes from a correlation matrix over many markets) — not a single-asset number, so
    transplanting it onto one coin at a time would not mean the same thing. The source's `0.20`
    is reported once as a labelled `SENSITIVITY` row, not as a registered arm.
- Applied on top of `SMA200_4H` and `EMA20_DAILY` (the two comparators) — not on the two new
  slow-trend variants, to keep the item-3 table a direct binary-vs-overlay comparison on
  already-registered signals rather than compounding two new things in the same table.
- Cost model: cost is charged on **`|Δweight|` per rebalance**, not a fixed per-switch cost
  (since weight is now continuous) — `equity *= 1 − |Δweight| × 0.15%`, the same convention
  `spot-portfolio.js` already uses (`ret -= Math.abs(target - w) * C`).
- Reported: turnover (sum of `|Δweight|`/year), cost paid, CAGR, Sharpe, maxDD, binary vs
  overlay, full history and common window.

## Item 4 — portfolio (Card 1.7)

- Universe: BTC/ETH/SOL, equal-weight (1/3 each notionally), **common window** only (SOL's
  eligible start constrains all three; a per-symbol window can't be equal-weighted).
- Each symbol runs its **own** `EMA20_DAILY` filter (the registered daily comparator — chosen
  for the portfolio specifically because it is the only registered arm with a native daily
  granularity matching `spot-portfolio.js`'s existing pattern, so the multi-symbol rebalancing
  loop stays on one clock; `SMA200_4H`/`SMA840_4H` run on a 4H clock and are not mixed into the
  same daily rebalancing loop in this WP).
- Arms:
  1. Equal-weight EMA20-filtered portfolio, **binary** long/flat per symbol, rebalanced to
     equal weight among the currently-long symbols (cash for the rest), explicit turnover cost.
  2. Same, with the item-3 vol-target+buffer overlay applied per symbol before combining.
  3. **Baseline — equal-weight buy-and-hold, fixed units**: buy 1/3 notional of each symbol
     once at the window start, hold the units, never rebalance (drifts with price; no turnover
     cost after the initial buy).
  4. **Baseline — equal-weight buy-and-hold, monthly-rebalanced**: reset to equal notional
     weight on the first trading day of each calendar month, paying turnover cost each time.
- Reported: CAGR, Sharpe, maxDD, turnover, cost paid, for all four arms, common window.

## Item 5 — break-even per side (all registered arms)

- Method: bisection on `costPerSide` (0% to 5%, matching `BREAKEVEN_COSTS_2026-09-27.md`'s
  existing table) against each arm's own backtest function, solving for:
  - **net = 0** (the cost at which the strategy's own net CAGR hits zero), and
  - **net = B&H** (the cost at which it stops beating buy-and-hold) — `Infinity` reported if the
    arm is already behind B&H at 0% cost (no crossing to solve for).
- Applied to `SMA200_4H`, `SLOW_SMA840_4H_V1`, `DONCHIAN_4W_V1`, `EMA20_DAILY`, per symbol,
  common window (for apples-to-apples with the rest of this study) — extends
  `BREAKEVEN_COSTS_2026-09-27.md`'s existing BTC/ETH/SOL × {SMA200, SMA840, EMA20} rows with the
  new Donchian row, using the same method (that doc's SMA200/SMA840/EMA20 numbers used the
  full-history window; WP7 reports the common window instead and states the difference).

## Tests (frozen before running)

`test-wp7-spot.js`:
1. **DCA accounting hand fixture** — 4-bar, hand-computed cash/units/cost trajectory (weekly
   $100 contribution, a buy while long, a sell-to-flat, cost applied on every trade) checked to
   machine precision.
2. **Buffer suppresses small rebalances** — `applyBuffer` leaves weight unchanged when
   `|target − current| ≤ buffer`, and snaps to target when it exceeds the buffer.
3. **Vol target caps at 1** — `volTargetWeight(targetVol, realizedVol)` returns exactly `1` when
   `targetVol > realizedVol` (would otherwise exceed full notional), and the uncapped ratio
   otherwise.
4. **Cross-check**: `runBinaryFilter()` (the new generic engine backing `DONCHIAN_4W_V1` and the
   EMA20 parity view) reproduces `runSma4h()`'s own numbers exactly (net CAGR, B&H CAGR, maxDD,
   trade count) when fed an SMA-based want-series on the same hand-built fixture — i.e. the new
   engine is not a second, divergent implementation of the same next-open-fill accounting.

## Verdict scale (fixed before results are seen)

Per arm: **REJECT** (no gross edge, or net result below both B&H and plain DCA with no
redeeming risk reduction) / **INCONCLUSIVE** (mixed across symbols/windows, or too little
history) / **PAPER CANDIDATE** (beats its relevant baseline net of the frozen 0.15%/side cost,
consistently across symbols and both the full-history and common windows).

## What this registration does NOT cover

- No perps/borrow scenarios (spot only, per the WP7 scope).
- No leverage, no shorting.
- No parameter fitting on this data — `28`, `840`, `40%`, `0.10` are fixed above, not chosen
  after looking at the results.
- Anything reported outside the tables this document defines is `EXPLORATORY` and does not
  change an arm's verdict.
