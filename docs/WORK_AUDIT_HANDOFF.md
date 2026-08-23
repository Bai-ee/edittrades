# EditTrades — Work Audit & Review Handoff

**Prepared for:** an independent reviewing agent
**Author:** the implementing agent (Claude)
**Date:** 2026-08-23
**Repo:** `Bai-ee/edittrades`

---

## 0. How to use this document

You are being asked to **verify, challenge, and approve or reject** the work described here. This document is written to be adversarially checkable: every substantive claim has a stated verification method, and Section 9 lists what I could **not** verify.

**Please do not take my numbers on trust.** Sections 3.6 and 4.6 give exact commands to reproduce them. Where I state a value, re-derive it.

**Bias disclosure:** I am the author of this work. I have tried to surface my own errors (Sections 3.5, 4.5, 6) but you should assume I have blind spots and look for what is *absent* from this document, not only what is in it.

---

## 1. TL;DR status

| Feature | State | Branch | Deployed? |
|---|---|---|---|
| **Bitcoin Economic Value** | Complete, live in production | merged to `main` @ `9efe37e` | **Yes** — verified 200 OK |
| **Risk Manager** | Engine + storage only; **no UI yet** | `claude/bitcoin-economic-value-jmpsbf` @ `a4769b6` | No |

**Production URL:** `https://snapshottradingview.vercel.app`
(Note: repo docs advertise `edittrades.vercel.app` — see Concern C7.)

Automated checks: Bitcoin — unit + e2e + browser render, all passing. Risk Manager — **93 assertions passing** including a 108-combination invariant sweep.

**Neither feature has had human code review or a pull request.** That is what you are for.

---

## 2. Scope of work performed

Two features, requested sequentially by the user:

1. **Bitcoin Economic Value** — a valuation page comparing BTC market price against a composite of long-duration economic anchors, plus a home-page readout and an API.
2. **Risk Manager** — a pre-trade position-sizing and portfolio-risk layer. Currently the deterministic engine and persistence only.

---

# PART A — BITCOIN ECONOMIC VALUE

## 3.1 What it does

Answers: *how expensive or cheap is Bitcoin relative to the economic prices that matter to holders, miners and long-term market structure?*

It is **not** a trading signal and does not claim a "true value" for Bitcoin.

### Files (all on `main`)

| File | Role |
|---|---|
| `services/bitcoinEconomicValue.js` | Pure deterministic calculation core |
| `services/bitcoinDataProviders.js` | Network I/O, caching, fallbacks |
| `api/bitcoin-economic-value.js` | HTTP handler (Express + Vercel) |
| `public/bitcoin-value.html` | Dedicated page |
| `public/index.html` | Home-page module + AI context wiring (modified) |
| `public/edittrax-styles.css` | Additive tokens only (modified) |
| `scripts/validate-economic-value.js` | Live validation harness |
| `docs/BITCOIN_ECONOMIC_VALUE.md` | Methodology documentation |

## 3.2 Methodology and why

**Economic Value = weighted geometric mean of anchors, in log space.**

```
EV = exp( Σ wᵢ · ln(anchorᵢ) )    with weights renormalised over available anchors
```

| Anchor | Weight | Family |
|---|---|---|
| Realized Price | 0.45 | On-chain aggregate cost basis |
| 200-week MA | 0.35 | Long-term market structure |
| Est. Miner Production Cost | 0.20 | Production economics |
| STH / LTH cost basis | 0 | **Unavailable** — no free provider |

**Design decisions and rationale:**

1. **Geometric, not arithmetic.** These are price levels compared as ratios. An anchor 50% above and one 50% below should average multiplicatively, and the result must not depend on which anchor is treated as base.
2. **MVRV and Puell carry zero weight.** MVRV = market cap / realized cap, which reduces to `price / realized price` — it is a transform of an anchor already in the composite. Weighting both would double-count. Puell is a *revenue condition*, not a price level. Both are reported as context only. **This directly satisfies the user's explicit anti-double-counting requirement.**
3. **Three structurally independent families.** They can disagree, and when they do, convergence reporting says so.
4. **Weights renormalise** over available anchors; below 2 anchors, no composite is emitted. No back-filling of anchors that did not yet exist.
5. **All smoothing is trailing-only and requires a full window.** No future information can enter a historical value. A partial window is a different statistic and is not presented as the same one.
6. **200W MA is built from completed weekly closes** — ISO weeks, last close per week, mean of last 200 completed. Not a 1400-period daily average.
7. **Miner cost uses dated curves** (efficiency J/TH, electricity $/kWh) interpolated log-linearly, so a 2015 estimate uses 2015-era hardware. No cost emitted before 2013-01-01 (pre-ASIC hardware mix makes any single efficiency figure meaningless).

## 3.3 Data worked through — real validation results

I validated against the **real Coin Metrics community dataset** (6,351 daily rows, 2009-01-03 → 2026-05-24), obtained from `github.com/coinmetrics/data` (`csv/btc.csv`).

### Price history vs published references

| Date | Computed | Reference | Δ | Event |
|---|---|---|---|---|
| 2017-12-17 | $19,250 | $19,650 | −2.0% | 2017 cycle high |
| 2021-11-10 | $64,756 | $69,000 | −6.2% | 2021 cycle high |
| 2022-11-21 | $15,778 | $15,750 | +0.2% | 2022 cycle low |
| 2024-03-14 | $71,505 | $73,750 | −3.0% | 2024 pre-halving high |

Deviations are expected: Coin Metrics is a **volume-weighted composite across venues**, whereas the reference figures are single-exchange ATH prints. **Reviewer: confirm you accept this explanation rather than treating it as error.**

### On-chain anchors at known market moments

| Date | Price | EV | Premium | Realized Price | MVRV | Event |
|---|---|---|---|---|---|---|
| 2018-12-15 | $3,185 | $3,952 | −19.4% | $4,613 | **0.69** | Bear bottom |
| 2020-03-12 | $4,959 | $5,743 | −13.6% | $5,652 | **0.88** | COVID crash |
| 2022-11-21 | $15,778 | $20,243 | −22.1% | $20,291 | **0.78** | FTX bottom |
| 2024-03-14 | $71,505 | $27,180 | +163.1% | $26,715 | **2.68** | 2024 high |

These MVRV values match published on-chain readings at those dates (~0.7 at Dec-2018 bottom, sub-1 at COVID, ~0.78 at FTX, ~2.6–2.8 at the 2024 high). **This is the strongest external validation in the work.**

### Independent cross-checks

| Check | Result |
|---|---|
| Realized Price (prod, 2026-08-21) | $52,813 vs published ~$52,330 (2026-08-08) → **0.9% over 13 days** on a slow series |
| 200W MA independent recomputation | **$61,095.86** vs module **$61,096** — exact match (different algorithm: ISO-week bucketing vs rolling window) |
| Implied network electricity draw | **~142 TWh/yr** — consistent with Cambridge CBECI-scale estimates |
| EV vs price volatility | EV **0.231%/day** vs price **2.502%/day** (ratio 0.092) — behaves as the slow baseline specified |
| Days BTC closed below EV | **4.2%** of all days |

### Live production response (2026-08-23)

```
BTC $77,106.30 (live-ticker)   EV $56,037.60   +37.6% PREMIUM   NEAR VALUE
Realized Price $52,812.56   200W MA $63,987.68   Miner Cost $51,174.95
MVRV 1.46   Puell 0.8946   Convergence 2/3 MODERATE AGREEMENT
5,879 rows, 2010-07-18 → 2026-08-21, dataAgeDays 0
realizedCapSource: "derived from CapMrktCurUSD / CapMVRVCur"
```

## 3.4 Data sources

| Source | Role | Auth |
|---|---|---|
| Coin Metrics Community API | Price, supply, hashrate, issuance, MVRV, market cap | **None** |
| Bitfinex public candles | Price-history fallback (2013+) | **None** |
| `services/marketData.js` (Kraken→CoinGecko) | Live spot price | **None** |

**No paid endpoint or API key is required.**

### Why existing EditTrades APIs were insufficient

This was challenged by the user and investigated:

- **Kraken OHLC caps at 720 data points** regardless of `since`. A 200-week MA needs 1,400 daily closes; Kraken gives ~1.97 years. The repo's weekly path derives weeks from those same 720 dailies → ~102 weeks.
- **CoinGecko free tier caps history at 365 days.**
- **Nothing in the repo touches the Bitcoin chain.** Realized cap is UTXO-level data an exchange price API structurally cannot provide.

## 3.5 Problems found and how they were solved

### P1 — `CapRealUSD` is not served by the community tier *(critical, load-bearing)*

**Found:** the published community dataset carries `CapMVRVCur` and `CapMrktCurUSD` but **not** `CapRealUSD`. Production confirmed the same: the extended metric request was rejected and fell back to the core set.

**Impact if unhandled:** Realized Price (weight 0.45, the heaviest anchor) would be null → composite drops to 2 anchors → every number on the page changes materially.

**Solution:** derive it. MVRV is *defined* as market cap / realized cap, so:
```
realizedCap = CapMrktCurUSD / CapMVRVCur
```
This is exact algebra, not an approximation. Verified **bit-exact** against the direct figure in a controlled test (relative difference `0.00e+0`). The API reports which path was used via `meta.sources.coinmetrics.realizedCapSource`.

**Status in production:** `realizedCapDerivedRows: 5879` — i.e. **all rows** are derived. This code path is not a fallback; it is the only path that works.

### P2 — Valuation state bands were badly miscalibrated *(caught only by real data)*

**Found:** calibrating percentiles over full history let the pre-2014 era dominate:

| Era | Median premium | Max |
|---|---|---|
| 2010–2013 | **+941%** | +4,186% |
| 2014–2017 | +97% | +917% |
| 2018–2021 | +90% | +611% |
| 2022–2026 | +63% | +170% |

This pushed **DEEP DISCOUNT to +1.6%** — Bitcoin trading at a *premium* would have been labelled a deep discount — and stretched NEAR VALUE to +99.6%.

**A hypothesis I had that was wrong:** I expected a log transform of the deviation to fix the skew. **It changes nothing.** Percentiles are order statistics and log is monotonic, so ranks do not move. I tested this rather than shipping the assumption. Only the *window* matters.

**Solution:** default calibration window = trailing **2,920 days (8 years, two halving cycles)**. Validation that it is correct — every known moment now lands in the right band:

| Moment | Premium | State |
|---|---|---|
| 2018-12-15 bear bottom | −19.4% | DEEP DISCOUNT |
| 2020-03-12 COVID crash | −13.6% | DEEP DISCOUNT |
| 2021-04-14 cycle top | +346% | EUPHORIC |
| 2022-11-21 FTX bottom | −22.1% | DEEP DISCOUNT |
| 2024-03-14 cycle high | +163% | EXTENDED |

### P3 — "Zero is fair value" is false for this composite

**Found:** all three anchors are *cost-like*. In a secularly appreciating asset, price normally trades **above** them. BTC has closed below EV on only **4.2%** of days; typical premium is **~+65–70%**, not 0%.

**Consequence:** a state like NEAR VALUE at +35% reads as a contradiction without context.

**Solution:** the header displays "Typical +65%" beside the current reading, and the methodology panel states explicitly that zero is not fair value for this composite.

### P4 — Contradictory colour semantics

**Found:** the headline showed **+30.8% in red** beside state **NEAR VALUE** in neutral — two different colour logics for one relationship, side by side.

**Solution:** the premium figure now takes its colour from the *same percentile bands* as the state label. A raw ±5% rule would paint an ordinary reading alarming red.

### P5 — Premium/discount panel unreadable over full range

**Found:** 2011–13 spikes above +3000% flattened every later cycle onto the zero line.

**Solution:** the panel scales to the 2nd–98th percentile of on-screen data, rounded to a round number. Outliers run visibly off-scale rather than being hidden.

### P6 — Phantom axis ticks

Chart.js rounded x-axis bounds outward, labelling years with no data (2008, 2027). Fixed by pinning axis min/max to the data extent.

## 3.6 How to re-verify (run these)

```bash
# 1. Live validation against real APIs — the single most important check.
npm run validate:btc-value

# 2. Production is live and serving real data
curl -s "https://snapshottradingview.vercel.app/api/bitcoin/economic-value?view=summary" | head -c 2000

# 3. Confirm the community API genuinely lacks CapRealUSD (P1)
curl -s "https://raw.githubusercontent.com/coinmetrics/data/master/csv/btc.csv" \
  | head -1 | tr ',' '\n' | grep -iE "real|mvrv|cap"

# 4. Independently recompute the 200W MA and compare to the API's ma200w
```

**What `validate:btc-value` checks:** provider health, anchor coverage, internal identities (realized price, MVRV, premium), 200W MA against an *independent recomputation using a different algorithm*, published price references, on-chain references, implied network consumption against a CBECI-scale band, that EV moves more slowly than price, and monotonic state thresholds.

**Its tolerances are deliberately wide.** It is built to catch a unit error or decimal slip, not to force dollar agreement. A `CHECK` line is a prompt to investigate, not a verdict.

## 3.7 Concerns — Bitcoin Economic Value

| # | Concern | Severity | Notes |
|---|---|---|---|
| **A1** | Entire feature depends on `CapMVRVCur` remaining available. If Coin Metrics drops it from the community tier, Realized Price dies and the composite degrades to 2 anchors. | **High** | Degrades honestly (anchors show UNAVAILABLE) but the page becomes much less useful. No mitigation exists — no alternative free realized-cap source was found. |
| **A2** | Miner cost efficiency/electricity curves are **my constructed estimates**, not sourced per-year measurements. Only the aggregate (implied TWh/yr) was sanity-checked. | **Medium** | Weight is 0.20. Labelled EST. MINER COST throughout. A reviewer should challenge the curve values in `ECONOMIC_VALUE_CONFIG.minerCost`. |
| **A3** | Percentile calibration includes the current observation in its own distribution. | **Low** | Negligible at n=2,920, but it is technically self-referential. |
| **A4** | 8-year window is a judgement call. Bands drift as history accumulates, so historical state labels are not stable over time. | **Medium** | Documented and configurable (`lookbackDays`). The alternative (full history) is demonstrably worse — see P2. |
| **A5** | STH/LTH cost basis unavailable; 2 of 7 chart toggles are permanently disabled. | **Low** | Explicitly permitted by the brief. Honestly labelled, not faked. |
| **A6** | Vercel in-memory cache is per-lambda-instance; cold starts refetch ~5,900 rows. | **Low** | Mitigated by `s-maxage=1800, stale-while-revalidate=86400` CDN header. Monitor for Coin Metrics rate-limiting. |
| **A7** | I never saw the production page render in a browser. Only the API response was verified live; the rendered page was verified against fixtures and a real-data local server. | **Medium** | **Reviewer should load the live page visually.** |

---

# PART B — RISK MANAGER

## 4.1 State: incomplete

**Built:** calculation engine, persistence layer, validation harness.
**Not built:** `/risk.html` page, home-page module, CHECK RISK integration, macro-context integration, history views.

Do not approve this as a shipped feature. Approve or reject the **engine design and correctness**.

### Files (feature branch only)

| File | Role |
|---|---|
| `public/js/riskManager.js` | Pure deterministic engine (1,003 lines) |
| `public/js/riskStore.js` | Persistence (404 lines) |
| `services/riskManager.js` | Thin re-export for server-side use (16 lines) |
| `scripts/validate-risk-manager.js` | 93-assertion harness (489 lines) |

## 4.2 Core semantics

The module is built around a distinction the user emphasised:

```
EXPOSURE   market value the position controls     e.g. $10,000
RISK       loss if the planned stop executes      e.g.    $250
MARGIN     capital posted to hold it              e.g.  $5,000
```

These are computed separately and **never collapsed**. Leverage reduces margin and moves the liquidation price; it **never** changes the loss at the stop.

**Sizing:** `notional = allowedRisk / stopDistance`, which makes loss-at-stop equal the risk budget *by construction*.

**Status vocabulary:** WITHIN PLAN / CAUTION / ABOVE PLAN / INCOMPLETE — deliberately never "SAFE".

## 4.3 Architecture decision requiring review

**The engine lives in `public/js/`, not `services/`.**

Reason: the position-size slider must recalculate on every drag. This project has **no build step**, and `vercel.json` serves only `public/**` to the browser. A module under `services/` could never reach the page. `services/riskManager.js` re-exports it so both sides share one implementation.

**Reviewer: confirm you accept this.** The alternative (an API round-trip per slider movement) would be materially worse UX. The tradeoff is that the engine is publicly readable — it contains no secrets, so this is judged acceptable.

## 4.4 Policy defaults — sourced

| Parameter | Value | Source |
|---|---|---|
| Risk per trade | **1.0%** | Van Tharp percent-risk; Turtle unit sizing (1 unit = 1N = 1% equity) |
| Max risk per trade | **2.0%** | Elder's 2% Rule |
| Max portfolio heat | **6.0%** | Elder's 6% Rule (= 6 × the 1% default) |
| Max correlated-direction risk | **4.0%** | Turtle structure: correlated basket gets 1.5× a single market's allowance |
| Max notional exposure | **200%** | ESMA 2:1 crypto CFD cap; Japan FSA 2x |
| Max leverage | **3.0×** | ESMA/FSA anchors + liquidation-distance argument |
| Maintenance margin (est.) | 0.5% | Typical base-tier |

### Disagreements recorded rather than papered over

1. **1% vs 2% are not a range to split.** 1% is a steady-state *target* (Tharp/Turtle); 2% is a *ceiling* against prior month-end equity (Elder). Both roles are stated explicitly in config comments.
2. **Heat is honestly 6–12%.** 6% is Elder's number; the Turtle lineage permits ~12 units in one direction. 6% is the conservative end.
3. **The 200% notional cap has NO trading-literature basis.** It is borrowed from securities regulation. This is stated in-code.
4. **1–2% risk is deep fractional Kelly, not growth-optimal.** It is a survival choice. The code does not claim it maximises returns.
5. **Slippage defaults are an assumption, not a measurement.** Published figures are tolerance settings, not expected costs.
6. **No diversification credit** for correlated positions — correlations converge toward 1.0 during drawdowns (BTC–SOL has printed 0.99 weekly under stress). Calm-window credit would understate heat exactly when it binds.

## 4.5 Problems found and how they were solved

### R1 — Concentration rule fired on ordinary books

**Found by test:** the book `BTC long $250 / SOL long $180 / ETH short $125` was flagged CORRELATED LONG EXPOSURE because longs held 77% of risk against a 60% threshold.

**Analysis:** in *any* three-position book, two same-direction positions will almost always clear 60%. The rule degenerated into "you have two positions the same way" — precisely the paternalistic noise the brief warns against.

**Solution:** raised the depth threshold to **80%**. Now: 3 longs → flagged (breadth rule); 2 longs + 1 short → not flagged; two dominant longs at 94% share → flagged.

**Note:** the test expectation was correct and the *implementation* was wrong. I changed the code, not the test.

### R2 — Correlated heat cap could be silently bypassed

**Found during implementation:** `detectCorrelatedExposure` only populated `directionRisk` when a rule tripped. Two same-direction positions at 2.5% each (5% one-way, over the 4% cap) offset by shorts would exceed the cap while never being flagged, so the cap would never be evaluated.

**Solution:** the function now always reports the dominant direction's stats, so the cap is evaluated independently of the flag.

### R3 — Aggregate notional cap was missing

**Found via research + my own tight-stop test:** a 0.1% stop sizes to **$250,000 notional on a $25,000 wallet** at nominally "1% risk". This passes every risk check while sitting one ordinary wick from liquidation.

**Solution:** enabled `maxNotionalExposurePct: 200`. Verified: 1000% exposure breaches; 76% does not.

### R4 — Wrong-side stops

A long with a stop *above* entry is a real user error. `Math.abs()` would silently produce a plausible-looking number. The engine **rejects** it with an explanatory error.

## 4.6 How to re-verify

```bash
npm run validate:risk
```

**93 assertions covering:** long/short, unleveraged/leveraged, extremely tight and very wide stops, wrong-side stops, zero and negative inputs, insufficient margin, single-trade and portfolio policy breaches, correlated longs, missing target, unavailable liquidation, and the size-override path the slider uses.

**Closes with a 108-combination sweep** asserting three invariants across wallet sizes, risk percentages, leverage levels and price scales:
1. dollar risk == wallet × risk%
2. notional × stop distance == dollar risk
3. margin × leverage == notional

**Worked example to check by hand:** $25,000 wallet, 1% risk, BTC entry $72,000, stop $69,500.
Stop distance = 2500/72000 = 3.4722%. Allowed risk = $250. Notional = 250/0.034722 = **$7,200**. Units = 0.1 BTC. Margin at 2× = **$3,600**. Loss at stop = **$250**.

## 4.7 Concerns — Risk Manager

| # | Concern | Severity |
|---|---|---|
| **B1** | **Liquidation is an isolated-margin approximation only.** Under cross margin it is an account-level quantity and the per-position formula is *invalid*, not merely imprecise. | **High** — mitigated by 5 explicit caveats ending "Never use this as a stop-loss" |
| **B2** | Real maintenance margin is **tiered by notional**, and the calculation is circular (MMR depends on notional, notional depends on the price being solved for). A flat 0.5% is used. | **Medium** — labelled EST. |
| **B3** | Exchanges liquidate on **mark price**, not last price. A liq price expressed against chart price is structurally the wrong quantity during a wick. | **Medium** — stated in caveats |
| **B4** | UI not built. Engine correctness is unproven *in use*. | **Expected** |
| **B5** | `notionalOverride` path changes the meaning of `riskPct` from input to output. Correct, but subtle — review the slider wiring when built. | **Low** |
| **B6** | Concentration is direction-only. It does **not** know BTC and ETH are correlated but BTC and gold are not. Any two same-direction positions count equally. | **Medium** — explicitly a v1 scope decision by the brief |

---

# 5. Persistence decision — requires explicit approval

**I chose local-first (`localStorage`) with cloud sync OPT-IN. This is a judgement call you should challenge.**

### What the investigation found

- **No server-side persistence exists.** `server.js` is **not deployed at all** — `vercel.json` serves `public/` statically and `api/*.js` as stateless functions with an ephemeral filesystem.
- **Firestore exists** (project `edittrades-fd451`, used by `tracker.html` for the `trades` collection) but:
  - **No authentication anywhere in the repo** — `firebase-auth-compat` is not even loaded
  - Rules are **`allow read, write: if true`** — world-readable and world-writable
  - The API key ships in page source
  - Writes are **global, not per-user**

### Why local-first

Trade signals already live under those rules. A **trading-wallet balance is materially more sensitive** — it states how much money the operator has. I judged it wrong to silently place account size into a publicly readable database.

### Cost of this choice

- Per-browser; **no cross-device sync**
- Cleared by clearing site data; not backed up
- `exportAll()` provided for manual backup

**Reviewer: this is reversible in one setting (`setCloudSyncEnabled(true)`). If the user wants sync more than privacy, flag it.**

---

# 6. Cross-cutting concerns

| # | Concern | Severity | Action needed |
|---|---|---|---|
| **C1** | **Firestore is world-readable and world-writable.** Anyone can read or delete all trade history. Pre-existing, not introduced by me. | **High** | Tighten Firestore rules. Independent of this work. |
| **C2** | **Pre-existing bug in `index.html` strategy toggles.** Buttons pass indices 0–3 but `strategyOptions` has 5 entries with `'TrendRider'` at index 2. Clicking **"Scalp" actually selects TrendRider**, "M-S" selects Scalp, and `MICRO_SCALP` is unreachable. Affects TRACK today. | **Medium** | I did not fix it (out of scope, changes existing behaviour). CHECK RISK will match TRACK's behaviour for consistency. **User decision needed.** |
| **C3** | `marketData.getCandles()` falls back to `generateSyntheticData()` — a **random walk** — when Kraken fails. Any consumer can silently receive fabricated candles. I deliberately routed Economic Value history *around* it. | **High** | Affects the existing 4H scanner. Not introduced by me, not fixed by me. |
| **C4** | Neither feature has had a pull request or human review. | **Medium** | This review. |
| **C5** | I committed Risk Manager work directly to `main` by mistake, then moved it to the feature branch and reset `main` to `origin/main`. **Verified `main` is byte-identical to deployed prod.** | **Resolved** | Confirm `git diff main origin/main` is empty. |
| **C6** | Branch name `claude/bitcoin-economic-value-jmpsbf` now carries Risk Manager work. | **Low** | Cosmetic. |
| **C7** | `DEPLOYMENT_INFO.md` advertises `edittrades.vercel.app`; live host is `snapshottradingview.vercel.app`. | **Low** | Docs cleanup. |
| **C8** | New CDN dependency: `chart.js@4.4.1` via jsDelivr (pinned). Repo already loaded unpinned `chart.js` in `strategy.html`. | **Low** | Consider self-hosting. |

---

# 7. What I did NOT do (deliberately)

- **No trade execution.** The Risk Manager does not place trades, connect to an exchange, or modify positions.
- **No adaptive position sizing** based on macro regime, volatility or setup quality. Context is *recorded* for future research; it does not alter sizing. The brief required collecting clean history first.
- **No AI in any calculation.** Both engines are pure. AI receives pre-computed values with an explicit instruction never to recalculate or estimate a null anchor.
- **No fabricated data.** Unavailable metrics report UNAVAILABLE with a reason. Gaps longer than 3 days are left null, not interpolated.
- **No fix to C2 or C3** — pre-existing bugs outside the requested scope.

---

# 8. Suggested review checklist

**Correctness**
- [ ] Run `npm run validate:btc-value` — do any `CHECK` lines appear?
- [ ] Run `npm run validate:risk` — do all 93 assertions pass?
- [ ] Verify the worked example in 4.6 by hand
- [ ] Independently recompute the 200W MA and compare to the live API's `ma200w`
- [ ] Confirm MVRV = price / realizedPrice in the live response

**Methodology**
- [ ] Is the geometric mean the right aggregation? (see 3.2)
- [ ] Is excluding MVRV and Puell from the composite correct?
- [ ] Is the 8-year calibration window defensible? (see P2)
- [ ] Are the miner-cost curves (A2) plausible? **Challenge these.**
- [ ] Are the risk-policy defaults appropriate for this user?

**Security / architecture**
- [ ] Is the local-first persistence decision right? (Section 5)
- [ ] Is `public/js/` acceptable for the risk engine? (4.3)
- [ ] Should C1 (Firestore rules) block anything?

**Live**
- [ ] Load `https://snapshottradingview.vercel.app/bitcoin-value.html` **visually** — I never saw it render in production (A7)
- [ ] Toggle every overlay, switch all four ranges, test tap inspection on mobile
- [ ] Confirm no horizontal overflow on a real phone

---

# 9. What I could NOT verify

Stated plainly, because these are the gaps most likely to hide a defect:

1. **I never saw the production page render.** Egress restrictions in my environment blocked all external hosts. Production was verified by **API response only**. Local rendering used fixtures and a real-data local server.
2. **I could not reach Coin Metrics, Kraken, CoinGecko or Bitfinex directly.** All live-data validation of the *Bitcoin* feature came from (a) the GitHub CSV archive, and (b) the production API response after deploy.
3. **`npm run validate:btc-value` has never been run against live APIs.** It was exercised against a fixture server only.
4. **The archive lags the live API** (2026-05-24 vs 2026-08-21). Anchor validation used archive data; the live figures were only sanity-checked, not fully re-validated.
5. **Miner-cost curves were not validated per-year** — only the present-day aggregate (implied TWh/yr).
6. **No load, concurrency or rate-limit testing** against Coin Metrics from Vercel.
7. **Risk Manager has never executed in a browser.** Node-only.

---

# 10. Verdict requested

Please return one of:

- **APPROVE** — both parts sound; Risk Manager may proceed to UI
- **APPROVE WITH CHANGES** — list required changes
- **REJECT** — state which claims failed verification

Please pay particular attention to **A1** (single point of failure), **A2** (unvalidated assumptions), **B1** (cross-margin invalidity), **Section 5** (persistence privacy tradeoff), and **C1/C3** (pre-existing security and data-integrity issues I did not fix).
