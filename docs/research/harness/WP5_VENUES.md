# WP5 — cross-venue data + real funding carry (research only, 2026-09-27)

Owner: docs/research/MASTER_PLAN_EDGE_HARNESS_2026-09-27.md, WP5 (R5 in EXTERNAL_HARNESS_REFERENCES.md,
Card 6.2 in BREAKEVEN_COSTS_2026-09-27.md). Branch `edge/wp5-venues`. Nothing here is approved for
implementation; no engine, tracker or live-signal files were touched.

**Coordinator update mid-task (2026-09-27):** real Jupiter borrow was independently measured today at
≈0.0013–0.0015%/h (`perps-api.jup.ag/v1/pool-info`, ~10% utilization), ≈0.004%/h at ~80% utilization —
both far below the 0.02%/h static proxy the break-even table used. Those two rates are added as their
own columns in the carry re-cost table below, next to the funding-by-venue columns.

## Code

- `scripts/research/edge/fetch-venue.js` — OHLCV (OKX, Bybit) and funding history (OKX, Bybit,
  Binance fapi, Hyperliquid) via direct public REST, no new deps. Pure helpers (pagination merge/
  dedupe, unfinished-candle drop, funding summation) are exported and unit-tested.
- `scripts/research/edge/cross-venue-check.js` — candle diff + SMA200/840 rerun, OKX vs Binance.
- `scripts/research/edge/carry-rerun.js` — Card 6.2 recompute: static Jupiter proxy vs owner-measured
  Jupiter rates vs real per-trade Hyperliquid/OKX funding, for the break-even table's 16 "borrow
  kills" edge-search configs.
- `scripts/research/edge/funding-by-year.js` — average annualized funding by year, spot-vs-perp context.
- `test-fetch-venue.js`, `test-carry-rerun.js` — plain-assert unit tests, hand fixtures, no network.

## Commands (run in this order; each writes its own `var/research/<name>/{REPORT.md,rows.json}`)

```bash
node test-fetch-venue.js
node test-carry-rerun.js
node scripts/research/edge/fetch-venue.js candles --venue okx   --market spot --symbols BTC,ETH,SOL --intervals 4h,1d --out var/edge/venues/okx
node scripts/research/edge/fetch-venue.js candles --venue bybit --market spot --symbols BTC,ETH,SOL --intervals 4h,1d --out var/edge/venues/bybit
node scripts/research/edge/fetch-venue.js funding --venues bybit,okx,binance,hyperliquid --symbols BTC,ETH,SOL --since 2023-05-01T00:00:00Z --out var/edge/venues/funding
node scripts/research/edge/cross-venue-check.js
node scripts/research/edge/carry-rerun.js --main ../snapshot_tradingview
node scripts/research/edge/funding-by-year.js
```

All commands were run on 2026-09-27 from this worktree. `var/` is not checked in; re-running refetches
live data, so exact byte counts will drift, but venue availability and the qualitative findings below
should not.

---

## 1. Data depth per venue (what was actually reachable from this host)

| Venue | OHLCV (spot, 4h/1d) | Funding history |
| --- | --- | --- |
| **Binance** (existing, `var/edge/4h-long`) | Reference baseline. BTC/ETH from 2017-08-17, SOL from 2020-08-11. | fapi.binance.com: **blocked, HTTP 451** (same geo-block as the spot API documented elsewhere in this repo). |
| **OKX** | Works. BTC/ETH from **2018-01-11**, SOL from **2020-09-30**, 0 gaps, validation OK (`var/edge/venues/okx/manifest.json`). 4H bars are natively UTC-aligned; 1D used the `1Dutc` bar (OKX's default 1D is UTC+8-aligned and would silently misalign vs Binance otherwise). | Works but **shallow: ~3 months only** (2026-06-22 → 2026-09-27, ~292 events/symbol, 2 pages). OKX's `funding-rate-history` endpoint simply doesn't retain more. |
| **Bybit** | **Blocked, HTTP 403** — "The Amazon CloudFront distribution is configured to block access from your country." Tried `api.bybit.com` and `api.bytick.com`; both blocked. Same class of restriction as Binance's 451, just via CloudFront instead of a direct API block. Code path (`fetchBybitCandles`/`fetchBybitFunding`) is written and correct for a host where it isn't blocked. | Same 403 block. |
| **Hyperliquid** | Not fetched (not requested for OHLCV; would need `candleSnapshot`, confirmed reachable in a smoke test but out of scope here). | Works, **full depth**: hourly, **2023-05-12 → now** (29,067 events/symbol, 59 paginated calls of ≤500). This is the only venue whose funding history covers the edge-search trade window (2024-10-01 → 2026-01-13) at all. |

**Consequence for item 3 below:** OKX's ~3-month funding window ends up entirely *after* the last
edge-search trade (2026-01-13), so it has **zero overlap** with the trade set — it cannot be used to
re-cost these specific trades, only reported as a recent reference rate. Bybit and Binance funding are
both blocked outright from this host. **Hyperliquid is the only venue with usable per-trade coverage.**
This is a host/network limitation, not a Hyperliquid-specific endorsement — see caveats.

## 2. Cross-venue robustness — OKX vs Binance (candles + SMA200/840 rerun)

Full detail: `var/research/cross-venue/REPORT.md`. Bybit is excluded (blocked, see above).

Close-price diff on shared timestamps, full overlap window per symbol:

| symbol | overlap window | matched bars | missing (either side) | median \|Δclose\| | mean \|Δclose\| | max \|Δclose\| | p95 \|Δclose\| |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 2018-01-11 → 2026-09-27 | 19,072 | 16 (Binance only, near-listing gap) | 0.0093% | 0.027% | 4.96% | 0.083% |
| ETH | 2018-01-11 → 2026-09-27 | 19,072 | 16 | 0.0105% | 0.028% | 4.42% | 0.087% |
| SOL | 2020-09-30 → 2026-09-27 | 13,130 | 0 | 0.0137% | 0.043% | 3.40% | 0.135% |

Prices track within ~1 basis point at the median; the ~4–5% single-bar maxima are isolated
flash-move/liquidation-cascade bars where venues briefly diverge (not investigated further here — they
affect a handful of 4h closes out of ~19k, immaterial to CAGR-level backtests).

SMA200 / SMA840 rerun (0.15%/side, no borrow) on OKX vs Binance, **identical overlap window**:

| symbol | N | Binance netCAGR | OKX netCAGR | Binance Sharpe | OKX Sharpe | Binance maxDD | OKX maxDD | Binance entries | OKX entries |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 200 | 33.6% | 35.7% | 0.91 | 0.94 | 57.6% | 53.3% | 264 | 263 |
| BTC | 840 | 46.0% | 57.6% | 1.09 | 1.29 | 48.5% | 41.4% | 64 | 60 |
| ETH | 200 | 53.9% | 62.0% | 1.06 | 1.17 | 56.2% | 52.7% | 227 | 221 |
| ETH | 840 | 34.9% | 49.2% | 0.80 | 1.00 | 63.5% | 63.7% | 76 | 74 |
| SOL | 200 | 104.0% | 105.2% | 1.27 | 1.27 | 87.3% | 87.3% | 217 | 216 |
| SOL | 840 | 122.1% | 91.5% | 1.35 | 1.19 | 71.1% | 70.9% | 80 | 77 |

**Reading:** SMA200 is robust to the data vendor for all three symbols (netCAGR, Sharpe, entry count
all close, same sign, same order of magnitude). SMA840 is directionally robust for BTC and ETH
(OKX actually somewhat *better*), but **diverges materially for SOL** (91.5% OKX vs 122.1% Binance,
n=77–80 trades) — a low-trade-count strategy where a couple of differently-timed entries/exits around
divergent bars move the result a lot. Treat SMA840-SOL as vendor-sensitive; SMA200 and SMA840-BTC/ETH
are not.

## 3. Card 6.2 carry re-cost — "borrow kills" configs vs real funding and real Jupiter

Full detail + a CEX-taker-fee variant table: `var/research/carry-rerun/REPORT.md`. All 16 of the
break-even table's "borrow kills" edge-search configs (`var/edge/train-r1.json` + `var/edge/train.json`)
were reclassified. Net R is the mean net R per trade at actual fees (0.20% long / 0.14% short round trip).

| config | n | long% | Jupiter static 0.02%/h | Jupiter measured 0.0015%/h | Jupiter stress 0.004%/h | Hyperliquid real funding | avg long carry %/h (HL) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F1-don-4h-N20-k3-reg | 139 | 47% | −0.139 (fails) | **+0.126** | +0.090 | +0.134 | 0.0022 |
| R2b-rsi2pb-1d-k2 | 35 | 66% | −0.014 (fails) | **+0.115** | +0.098 | +0.120 | 0.0014 |
| F4-squeeze-4h-k3-reg | 58 | 43% | −0.112 (fails) | **+0.109** | +0.079 | +0.118 | 0.0020 |
| F4-squeeze-4h-k2-reg | 60 | 45% | −0.088 (fails) | **+0.089** | +0.065 | +0.097 | 0.0020 |
| F1-don-4h-N20-k3 | 250 | 51% | −0.186 (fails) | **+0.075** | +0.040 | +0.087 | 0.0020 |
| R2b-rsi2pb-1d-k3-long | 23 | 100% | −0.034 (fails) | **+0.080** | +0.065 | +0.082 | 0.0013 |
| F1-don-4h-N55-k2 | 197 | 55% | −0.094 (fails) | **+0.071** | +0.049 | +0.072 | 0.0027 |
| F1-don-4h-N55-k3 | 149 | 54% | −0.181 (fails) | **+0.056** | +0.024 | +0.061 | 0.0025 |
| F1-don-4h-N55-k2-reg | 139 | 53% | −0.122 (fails) | **+0.040** | +0.018 | +0.042 | 0.0026 |
| F1-don-4h-N55-k3-reg | 105 | 51% | −0.202 (fails) | **+0.035** | +0.003 | +0.040 | 0.0024 |
| F1-don-4h-N20-k2 | 359 | 51% | −0.142 (fails) | **+0.032** | +0.008 | +0.039 | 0.0020 |
| F1-don-4h-N20-k2-reg | 198 | 49% | −0.140 (fails) | **+0.032** | +0.009 | +0.036 | 0.0024 |
| F2-tsmom-1d-L60-k2 | 106 | 58% | −0.422 (fails) | **+0.009** | −0.049 (fails) | +0.026 | 0.0018 |
| R2b-rsi2pb-1d-k2-long | 23 | 100% | −0.133 (fails) | **+0.012** | −0.007 (fails) | +0.014 | 0.0014 |
| F4-squeeze-4h-k3 | 117 | 52% | −0.248 (fails) | −0.017 (fails) | −0.048 (fails) | −0.004 (fails) | 0.0016 |
| F2-tsmom-1d-L20-k2 | 116 | 52% | −0.448 (fails) | −0.029 (fails) | −0.085 (fails) | −0.011 (fails) | 0.0020 |

**Headline:**
- **14 of 16 "borrow kills" configs flip to net-positive** once the static 0.02%/h proxy is replaced
  by either (a) the owner-measured real Jupiter rate (0.0015%/h) or (b) real Hyperliquid funding summed
  per trade over its actual hold. The two agree closely with each other: every surviving config's
  average long carry on Hyperliquid (0.0013–0.0027%/h) sits right next to the measured Jupiter rate
  (0.0015%/h) — the 0.02%/h proxy was simply ~10–15x too harsh for this trade population's typical
  holding period (mostly hours, not days).
- **12 of 16 still survive at the 0.004%/h stress rate** (80% utilization); `F2-tsmom-1d-L60-k2` and
  `R2b-rsi2pb-1d-k2-long` flip back to failing at stress, and `F4-squeeze-4h-k3` /
  `F2-tsmom-1d-L20-k2` never clear any real-cost scenario (their gross edge is too thin even before
  borrow — they were "no gross edge" or "fees kill" adjacent to begin with).
- At the CEX-taker fee variant (0.11% RT flat, both directions — cheaper than the default 0.20% long
  leg), the same 14 configs survive and margins widen further (see `var/research/carry-rerun/REPORT.md`
  for the full table).
- **OKX real-funding column is n/a for every config** — its ~3-month depth doesn't reach back to any
  edge-search trade (see §1).

**This is the single most consequential finding in this WP:** the break-even table's "borrow kills"
verdict (Card 6.2, `docs/research/BREAKEVEN_COSTS_2026-09-27.md`) was driven almost entirely by the
static 0.02%/h borrow assumption, not by the trades' actual economics. Under either measured real cost
source, most of that group is economically viable on cost grounds alone (separate from whether the
underlying signal itself is real — R3/R3b significance testing, not run here, still applies).

## 4. Spot-vs-perp context — average annualized funding by year (BTC/ETH/SOL longs)

Full detail: `var/research/funding-by-year/REPORT.md`. Hyperliquid, hourly, positive = longs pay:

| year | BTC | ETH | SOL |
| --- | --- | --- | --- |
| 2023 (partial, from 05-12) | 15.06% | 22.37% | 13.04% |
| 2024 | 24.14% | 22.05% | 28.14% |
| 2025 | 10.63% | 8.53% | 5.31% |
| 2026 (partial, through 09-27) | 5.04% | 5.71% | −0.14% |

OKX's own ~3-month snapshot (2026-06-22 → 2026-09-27) annualizes much higher — BTC 44.7%, ETH 32.7%,
SOL 25.8% — than Hyperliquid's 2026 partial-year average (5.0–5.7%, SOL slightly negative). That's a
real venue/period difference, not a bug: it's a 3-month sample vs a 9-month average, and CEX vs
Hyperliquid funding mechanics differ (see caveats). Do not treat the OKX figure as "the" current rate.

The edge-search trade window (2024-10-01 → 2026-01-13) sits mostly inside 2024's high-funding regime
(22–28% annualized) tapering into 2025's much lower one (5–11%) — consistent with §3's finding that the
static 0.02%/h (≈175%/yr) proxy was well above anything actually realized on Hyperliquid across the
whole trade window.

## Caveats

- **Funding ≠ Jupiter borrow**, mechanically. Funding is a periodic payment between longs and shorts on
  a CEX/Hyperliquid perp (can be negative, i.e. longs get paid); Jupiter borrow is a pool-utilization
  interest rate charged to whoever holds the position, independent of any counterparty payment, and is
  never negative. Reporting Hyperliquid funding next to Jupiter's measured/stress rates is a **reference
  comparison**, not a claim that Jupiter behaves like Hyperliquid funding.
- **Venue choice is an owner decision.** Nothing here proposes moving execution off Jupiter Perps. The
  cross-venue and funding data exist to sanity-check whether results depend on one vendor and to give a
  more realistic carry-cost band than the original static proxy — not to recommend Bybit/OKX/Hyperliquid
  as execution venues.
- **Bybit is unreachable from this host** (403, CloudFront country block) for both candles and funding.
  Binance fapi funding is 451-blocked, matching the existing documented block on Binance's spot API.
  Neither could be cross-checked here; re-run from an unblocked host to fill this gap.
- **OKX funding depth (~3 months) has zero overlap with the edge-search trade window** — its "n/a" in
  the carry re-cost table is a genuine coverage gap, not a computed zero.
- **SMA840-SOL is vendor-sensitive** (§2); treat any SMA840-SOL headline number as fixture-dependent
  until reconciled against a third venue.
- The carry re-cost (§3) still uses the *original* edge-search trades (Round 1 train-phase, Round 2
  train-phase) — it does not re-run the strategies on OKX/Hyperliquid price data, only re-costs the
  same Binance-sourced trades with different borrow/funding assumptions. A full re-simulation on another
  venue's prices is out of scope here.
- Funding-by-year (§4) reports the simple mean hourly rate annualized; it is not volume- or
  position-weighted, and says nothing about whether any given trade would have been filled at that
  funding rate.
