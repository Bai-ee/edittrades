# Bitcoin Economic Value

A valuation reference for EditTrades that answers one question:

> How expensive or cheap is Bitcoin relative to the economic prices that matter
> to holders, miners and long-term market structure?

This is **not** a trading signal, a price floor, a guarantee, or a claim about
Bitcoin's "true value". It is a derived reference built from public data, with
its methodology, assumptions and source health exposed in the UI.

---

## What ships

| Piece | Path |
| --- | --- |
| Calculation core (pure, deterministic) | `services/bitcoinEconomicValue.js` |
| Data providers + caching | `services/bitcoinDataProviders.js` |
| API handler | `api/bitcoin-economic-value.js` |
| Express route | `server.js` → `GET /api/bitcoin/economic-value` |
| Vercel route | `vercel.json` |
| Dedicated page | `public/bitcoin-value.html` |
| Home-page quick reference | `public/index.html` |
| Validation harness | `scripts/validate-economic-value.js` |

Run the validation harness with:

```bash
npm run validate:btc-value
```

---

## Methodology

### The composite

Economic Value is a **weighted geometric mean** of long-duration economic
anchors, computed in log space:

```
EV = exp( Σ wᵢ · ln(anchorᵢ) )      where Σ wᵢ = 1 over available anchors
```

Geometric rather than arithmetic because these are price levels compared as
ratios. An anchor 50% above and one 50% below should average to the middle
multiplicatively, and the result must not depend on which anchor you treat as
the base.

| Anchor | Weight | Family |
| --- | --- | --- |
| Realized Price | 0.45 | On-chain aggregate cost basis |
| 200-week moving average | 0.35 | Long-term market structure |
| Estimated Miner Production Cost | 0.20 | Production economics |
| LTH Realized Price | 0 (unavailable) | On-chain cost basis |
| STH Realized Price | 0 (unavailable) | On-chain cost basis |

Weights reflect how *measured* each anchor is. Realized Price is an observed
aggregate, not an estimate, so it leads. The 200-week MA is a clean, purely
mechanical market-structure anchor. Miner cost carries the most assumptions, so
it carries the least weight.

**Weights are renormalised over whichever anchors exist on a given date.** The
200-week MA does not exist before 200 weeks of history have accumulated, and
miner cost is not emitted before the ASIC era. Rather than back-filling values
that did not exist, the composite reweights what it has. A composite is only
emitted when at least **two** anchors are present.

### Avoiding double counting

Anchors that are mathematically derived from one another are never both
weighted:

- **MVRV** is `Market Cap / Realized Cap`, which reduces to
  `price / realized price`. It is a transform of an anchor already in the
  composite, so it is reported as **context only** and carries no weight.
- **Puell Multiple** is a miner *revenue condition* metric — daily issuance
  value against its own annual average. It is not a price level, and it is kept
  conceptually separate from Estimated Miner Production Cost. Also context only.

The three weighted anchors come from three structurally independent families,
which is the point: they can disagree, and when they do, that disagreement is
reported (see Convergence).

### Smoothing

| Series | Treatment | Why |
| --- | --- | --- |
| Miner cost | trailing 30-day mean | Removes difficulty-retarget and halving step changes |
| Composite | trailing 14-day mean | Keeps the line reading as a slow economic baseline |

Both are **trailing only, never centred**, so no future information can enter a
historical value. A smoothed value is emitted only once the window is completely
full — a partial window is a different statistic and is not presented as the
same one.

---

## The anchors

### Realized Price

```
Realized Price = Realized Cap / circulating supply
```

The aggregate on-chain cost basis of the supply, valuing every coin at the price
it last moved. It is never approximated with a moving average.

Realized cap is taken from `CapRealUSD` when the tier publishes it. Coin Metrics'
published community dataset carries MVRV and market cap but **not** realized cap,
so the provider also derives it:

```
realizedCap = CapMrktCurUSD / CapMVRVCur
```

MVRV is *defined* as market cap / realized cap, so this is exact algebra, not an
approximation — verified bit-exact against the direct figure. Without it, a tier
withholding `CapRealUSD` would cost the heaviest-weighted anchor. The API reports
which path was used in `meta.sources.coinmetrics.realizedCapSource`.

### 200-week moving average

Computed from **completed weekly closes**, not from a 1,400-period average of
daily candles and not from 200 periods of whatever timeframe is on screen. Daily
rows are bucketed into ISO weeks (Monday start), each week's final close is
taken, and the last 200 completed weekly closes are averaged. This is exactly
what a weekly chart shows.

Emits `null` until 200 completed weeks exist.

### Estimated Miner Production Cost

```
energy J/day  = hashrate(TH/s) × 86400 × efficiency(J/TH)
kWh/day       = J/day ÷ 3.6e6
cost/day      = kWh/day × electricity($/kWh) × overheadMultiplier
cost per BTC  = cost/day ÷ BTC issued that day
```

An estimate of **marginal cash cost**, labelled `EST. MINER COST` throughout.
It is explicitly not a floor: miners routinely produce below cost, and hashrate
leaves the network when they do.

Assumptions are dated curves interpolated **log-linearly**, so a 2015 estimate
uses 2015-era hardware rather than today's:

- **Fleet efficiency** ranges from ~8,000 J/TH (2013) to ~20 J/TH (2026). These
  are *network fleet averages*, not best-in-class: a new flagship ASIC is
  roughly twice as efficient as the network average around it. Cross-check: the
  2025 anchor (24 J/TH) at ~800 EH/s implies ~170 TWh/yr, consistent with the
  Cambridge CBECI best-guess estimate.
- **Electricity** ranges from $0.080/kWh (2013) to $0.045/kWh (2025), reflecting
  miner migration toward cheaper power.
- **Overhead multiplier** of 1.25× covers hardware amortisation, hosting, pool
  fees and staff — i.e. energy is treated as ~80% of cash cost.

Transaction fees are **excluded** from the denominator: issuance alone backs out
cost per coin. Crediting production cost with fee revenue would understate it.

No cost is emitted before **2013-01-01**. Before the ASIC era the hardware mix
(CPU/GPU/FPGA) makes any single efficiency figure misleading.

### STH / LTH Realized Price — unavailable

Genuine short- and long-term holder cost basis requires age-banded realized cap,
which no free provider publishes. The methodology forbids approximating them
with a moving average, so they are reported as **UNAVAILABLE**, their chart
toggles are disabled, and the API explains why in `meta.sources`.

To enable them, wire a provider (Glassnode, CryptoQuant, a paid Coin Metrics
tier) into `services/bitcoinDataProviders.js` so rows carry
`sthRealizedPrice` / `lthRealizedPrice`, then give them weight in
`ECONOMIC_VALUE_CONFIG.weights`. Everything downstream already handles them.

---

## Premium / Discount

```
Premium/Discount % = (price − economicValue) / economicValue × 100
```

Positive means Bitcoin trades above its economic anchors; negative, below.

A premium is **not** bearish and a discount is **not** bullish. Neither is a
trade signal, and the UI never labels either BUY or SELL.

---

## Valuation states

Thresholds are **not** hand-picked percentages. They are percentile cut points
of Bitcoin's own historical premium/discount distribution, so the bands describe
how far Bitcoin has actually traded from its anchors rather than a number
somebody chose.

| State | Band |
| --- | --- |
| DEEP DISCOUNT | below the 5th percentile |
| DISCOUNT | 5th → 20th |
| NEAR VALUE | 20th → 55th |
| PREMIUM | 55th → 80th |
| EXTENDED | 80th → 95th |
| EUPHORIC | above the 95th percentile |

The percentiles live in `ECONOMIC_VALUE_CONFIG.valuationStates.percentiles` and
are adjustable. The resolved percentage values are returned in the API response
and rendered on the page, so the calibration is inspectable rather than implied.

### Zero is not "fair value"

All three anchors are cost-like measures — what holders paid, what the long-run
average is, what production costs. In a secularly appreciating asset, price
normally trades **above** all three. Measured on real Coin Metrics data, Bitcoin
has closed below Economic Value on only ~4% of days, and the typical premium is
around **+70%, not 0%**.

So Economic Value is a *cost-basis composite*, closer to a floor-ish reference
than a midpoint. The bands measure position against Bitcoin's own history rather
than against zero, which is why a reading of +35% can sit in NEAR VALUE. The page
displays the typical premium beside the current one so this is legible rather
than surprising.

### Calibration window

`lookbackDays` defaults to **2,920 days (8 years, two halving cycles)**. Bitcoin's
early history is a structurally different asset and otherwise dominates the
distribution. Measured on real data:

| Era | Median premium | Max premium |
| --- | --- | --- |
| 2010–2013 | +941% | +4,186% |
| 2014–2017 | +97% | +917% |
| 2018–2021 | +90% | +611% |
| 2022–2026 | +63% | +170% |

Calibrating on full history pushes the DEEP DISCOUNT threshold to **+1.6%**,
which would label Bitcoin trading at a premium a "deep discount". The eight-year
window puts every known market moment in the right band:

| Moment | Premium | State |
| --- | --- | --- |
| 2018-12-15 bear bottom | −19.4% | DEEP DISCOUNT |
| 2020-03-12 COVID crash | −13.6% | DEEP DISCOUNT |
| 2021-04-14 cycle top | +346% | EUPHORIC |
| 2022-11-21 FTX bottom | −22.1% | DEEP DISCOUNT |
| 2024-03-14 cycle high | +163% | EXTENDED |

Note that percentiles are **order statistics**, so transforming the deviation
(log ratio instead of percentage) does not move the cut points at all — only the
window does. This was tested rather than assumed.

Bands require at least 365 observations, below which the state reports
`UNCALIBRATED` rather than guessing.

Because the state is percentile-calibrated, the premium figure on the page takes
its colour from the **same bands**. A raw ±5% colour rule would paint a reading
alarming red beside a state label calling it ordinary.

---

## Economic convergence

How tightly the anchors cluster around the composite:

- An anchor **agrees** when within ±12% of the composite.
- **Spread** = `max anchor / min anchor − 1`.

| Agreement | Condition |
| --- | --- |
| HIGH | ≥75% of anchors agree **and** spread ≤ 25% |
| MODERATE | ≥50% agree **or** spread ≤ 50% |
| LOW | otherwise |

Displayed as e.g. `3/3 anchors agree · HIGH AGREEMENT`. This describes agreement
between independent measures. It is **not** a statistical confidence interval
and is not presented as one.

---

## Data sources

| Source | Role | Auth |
| --- | --- | --- |
| [Coin Metrics Community API](https://community-api.coinmetrics.io/v4) | Price, realized cap, supply, hashrate, issuance. Full history from 2009. | **None** |
| [Bitfinex public candles](https://api-pub.bitfinex.com/v2) | Price-history fallback (daily BTC/USD from 2013). Price only — no on-chain anchors. | **None** |
| `services/marketData.js` (Kraken → CoinGecko) | Live spot price for the headline figure | **None** |

**No paid endpoint and no API key is required** for anything the composite uses.

Metrics requested: `PriceUSD`, `SplyCur`, `HashRate`, `IssTotNtv`,
`CapMVRVCur`, `CapMrktCurUSD` (core), plus `CapRealUSD` and `IssTotUSD`
(extended). If the extended request fails — a renamed or ungranted metric would
reject the whole batch — the provider retries with the core subset, which is
sufficient on its own because realized cap is recoverable from MVRV.

`HashRate` is reported by Coin Metrics in **terahashes per second**, which is
what the miner-cost estimator expects. No conversion is applied.

### Why EditTrades' existing APIs are not sufficient

The feature needed sources beyond what the repo already had, for two structural
reasons rather than preference:

- **Kraken's OHLC endpoint caps at 720 data points** regardless of `since`. A
  200-week MA needs 1,400 daily closes; Kraken supplies ~1.97 years. The repo's
  weekly path derives weeks from those same 720 dailies, yielding ~102 weeks.
- **CoinGecko's free tier caps history at 365 days.**
- Nothing in the repo touches the Bitcoin chain, and realized cap is UTXO-level
  data that an exchange price API structurally cannot provide.

Note also that `marketData.getCandles()` falls back to `generateSyntheticData()`
— a random walk — when Kraken fails. This module deliberately does **not** route
history through it, since a provider hiccup would otherwise render a valuation
from random numbers. The spot-price path it does use (`getTickerPrice`) has no
synthetic fallback.

### Validation archive

Coin Metrics also publishes the community dataset as CSV at
[github.com/coinmetrics/data](https://github.com/coinmetrics/data)
(`csv/btc.csv`). It lags the API by weeks to months, so it is unsuitable as a
live source, but it is useful for offline validation and for confirming which
metrics the community tier carries.

TradingView is not scraped and no proprietary indicator data is copied.

### Optional environment overrides

| Variable | Effect |
| --- | --- |
| `COINMETRICS_API_BASE` | Point at a paid tier, an internal proxy, or a fixture server |
| `COINMETRICS_API_KEY` | Unlocks paid-tier metrics and rate limits through the same code path |
| `BITFINEX_API_BASE` | Override the fallback price source |

---

## Caching

| Data | TTL | Notes |
| --- | --- | --- |
| Spot price | 60s | Drives the headline number |
| Historical series | 6h | On-chain metrics publish once per day |
| CDN (`Cache-Control`) | `s-maxage=1800, stale-while-revalidate=86400` | Serves the previous copy while refreshing |

A **stale cache is always preferred over an error**. When every provider is
unreachable and no cache exists, the endpoint returns `503` with source status
rather than a fabricated reading.

---

## Failure handling

| Situation | Behaviour |
| --- | --- |
| Provider gap ≤ 3 days | Forward-filled per field |
| Provider gap > 3 days | Left `null` — never interpolated across |
| Anchor unavailable | Weights renormalise over the rest |
| Fewer than 2 anchors | No composite emitted |
| Coin Metrics down | Bitfinex price fallback; on-chain anchors reported unavailable |
| Everything down | Stale cache, else `503` with source detail |
| On-chain feed behind price feed | `dataAgeDays` surfaced; page shows a notice past 3 days |

Missing data is never interpolated across large gaps, and the chart draws real
gaps as gaps (`spanGaps: false`) rather than a straight line through an outage.

---

## API

```
GET /api/bitcoin/economic-value
```

| Parameter | Values | Default |
| --- | --- | --- |
| `range` | `1y` `2y` `5y` `all` | `all` |
| `view` | `full` `summary` | `full` |
| `refresh` | `true` | — |

`view=summary` omits history for the home-page module (~4KB vs ~220KB).

Long ranges are thinned server-side (5Y every 2 days, ALL weekly) to keep
payloads small. Thinning **drops whole daily observations rather than averaging
them**, so every surviving point keeps its own real price, Economic Value and
premium — hover inspection never reports a blended figure that never existed.

```jsonc
{
  "current": {
    "date": "2026-08-20",
    "price": 67088.0,
    "priceSource": "live-ticker",
    "economicValue": 51283.0,
    "premiumDiscount": 30.82,
    "direction": "PREMIUM",
    "state": "NEAR VALUE",
    "stateTone": "neutral",
    "anchors": { "realizedPrice": 56623, "ma200w": 46541, "minerCost": 50159,
                 "sthRealizedPrice": null, "lthRealizedPrice": null },
    "weightsApplied": { "realizedPrice": 0.45, "ma200w": 0.35, "minerCost": 0.20 },
    "context": { "mvrv": 1.18, "puell": 0.95 },
    "convergence": { "within": 3, "total": 3, "agreement": "HIGH AGREEMENT" },
    "minerAssumptions": { "efficiencyJPerTh": 18.9, "electricityUsdPerKwh": 0.045 }
  },
  "history": [ { "date": "...", "timestamp": 0, "price": 0, "economicValue": 0,
                 "premiumDiscount": 0, "ma200w": 0, "realizedPrice": 0,
                 "minerCost": 0, "mvrv": 0, "puell": 0, "anchorsUsed": [] } ],
  "methodology": { },
  "distribution": { },
  "meta": { "sources": { }, "anchorStatus": { } }
}
```

---

## AI integration

The current reading is passed to the existing AI market review as
`BITCOIN_ECONOMIC_VALUE` inside the request payload, with an explicit
instruction in the system prompt:

> …you may interpret it as longer-term valuation context, but you must never
> recalculate it, estimate any anchor that is null, or treat a premium or
> discount as a buy or sell signal.

Every figure handed to the model is already derived deterministically
server-side. The AI interprets; it never computes an anchor or fills a gap.

---

## Validation

`scripts/validate-economic-value.js` runs the live provider → calculation path
and checks:

1. Provider health and spot availability
2. Anchor coverage and composite formation
3. Internal identities — realized price, MVRV, premium
4. 200-week MA against an **independent recomputation** using a different
   algorithm (ISO-week bucketing vs the module's rolling window)
5. Price history against published cycle highs and lows
6. Realized price and MVRV against published on-chain references
7. Miner assumptions, including implied network consumption against a
   CBECI-scale band
8. That Economic Value actually behaves as a slow baseline, not a second price
   line
9. Monotonic state thresholds
10. The current reading and on-chain feed freshness

External references are quoted from third parties with their own methodology
differences. Tolerances are wide by design: the harness is built to catch a unit
error or a decimal slip, not to force agreement to the dollar. A deviation
outside tolerance prints `CHECK` and is a prompt to investigate, not a verdict.

---

## Adjusting the methodology

Everything tunable lives in `ECONOMIC_VALUE_CONFIG` at the top of
`services/bitcoinEconomicValue.js`: weights, smoothing windows, miner
assumptions, percentile cut points, convergence bands, gap tolerance.

Bump `version` whenever a change alters output. The version is returned in every
API response and rendered on the page, so any figure can be traced back to the
methodology that produced it.
