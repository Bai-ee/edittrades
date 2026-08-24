# Volatility Regime & GARCH — Assessment and Handoff

**From:** the assessing agent
**Branch:** `claude/volatility-predictor-garch-l66cb6`
**Repo:** `Bai-ee/edittrades`
**Date:** 2026-08-24
**Status:** assessment only — **no code has been changed**

---

## 0. Read this first

This document evaluates a proposal to add a **GARCH volatility predictor** to the
system, and recommends a different — and cheaper — sequence of work.

The headline conclusion:

> **GARCH is not the highest-value change available here, and it is not even in
> the top three.** The system already computes volatility, already has a
> sophisticated adaptive-risk layer, and already sizes positions off structural
> stops. What it does not have is any wire connecting those three things. The
> volatility signal is computed for display and then discarded.

There is also **one live bug** (§4.1) that makes the existing volatility
classifier return a near-constant value for most assets. That bug should be
fixed regardless of whether any of the rest of this is pursued.

**Nothing in this document is a prediction of price.** Everything here concerns
position sizing and risk capacity, consistent with the existing engine's stated
non-negotiables (`docs/ADAPTIVE_RISK_ENGINE.md` §1).

---

## 1. The source claim

The proposal came from a social post (link was `x.com`, unreachable from the
build environment — assessment is based on the pasted text). Its argument, in
summary:

1. Robert Engle won the Nobel for proving volatility is predictable.
2. Volatility clusters — high vol today predicts high vol tomorrow at "70%+".
3. The model is GARCH, ~60 lines of Python, in every econometrics textbook.
4. On 10 years of SPY: low-vol → 74% chance next session stays low vol; vol
   spike → 81% chance next session is also elevated.
5. "A trader right 48% of the time who sizes with vol awareness beats someone
   right 62% of the time sizing blindly — every time, over any long enough
   sample."
6. Quant desks ask "will the next move be large or small?", not "up or down?".

---

## 2. Assessment of the claim

### 2.1 What is correct

| Claim | Verdict |
|---|---|
| Engle's ARCH work is Nobel-recognised | **True.** Engle (1982), *Econometrica*; Nobel 2003, shared with Clive Granger. Generalised to GARCH by Bollerslev (1986). |
| Volatility clusters | **True, and robust.** One of the most reliably reproduced empirical regularities in finance — holds across equities, FX, commodities, and crypto. |
| Conditional variance is more forecastable than conditional mean | **True.** This asymmetry is the genuinely useful kernel of the post. |
| Sizing inside a vol regime matters | **True**, and it is the part worth acting on. |

### 2.2 What is overstated

**The "74% / 81% / 70%+" figures are close to uninformative.**

These are *regime persistence* rates, not model accuracy. A model that says
"tomorrow equals today" scores nearly the same, because volatility is highly
autocorrelated by construction. The meaningful benchmark is not 50% (coin flip)
— it is the naive persistence baseline. Against that baseline, GARCH wins by a
modest margin, not a dramatic one.

Supporting evidence cuts both ways: Hansen & Lunde (2005), *"A forecast
comparison of volatility models: does anything beat a GARCH(1,1)?"*, compared
330 models and found GARCH(1,1) was not outperformed on exchange-rate data —
though for equity returns, models carrying a leverage term (see §2.3) did beat
it. Read honestly, that paper says GARCH(1,1) is a strong default **and** that
the achievable ceiling above it is low.

Separately, HAR-RV models (Corsi, 2009) built on intraday realised variance
generally outperform daily GARCH outright. If maximum forecast accuracy were the
goal, GARCH would not be the destination.

**The "hedge funds never told retail" framing is self-refuting.** The post
concedes two lines later that this is "chapter 4 of every econometrics textbook".
It is in chapter 4 *because* it is public. Volatility persistence is also
thoroughly reflected in the options surface; it is not a hidden edge.

### 2.3 What is wrong

**Claim 5 — the 48%-vs-62% assertion — is false as stated, and is the most
important thing to get right before building anything.**

Position sizing **amplifies the sign of an edge; it does not create one**. A 48%
win rate with symmetric payoffs is negative expectancy. Vol-aware sizing applied
to it produces a slower, better-behaved loss — not a profit. The Kelly criterion
is explicit: optimal fraction on a negative edge is zero.

The defensible version of the claim is:

> *Given positive expectancy*, vol-aware sizing dominates flat sizing on
> risk-adjusted terms (Sharpe, max drawdown).

That is true, worth acting on, and considerably less dramatic. **Set
expectations accordingly: this work should improve Sharpe and shrink drawdown.
It will not improve hit rate.**

**Plain Gaussian GARCH(1,1) is also the wrong specification for crypto.** It is
symmetric — it assumes a −5% day and a +5% day raise tomorrow's variance
equally. Empirically they do not (the leverage effect). Appropriate variants:

- **GJR-GARCH** (Glosten, Jagannathan & Runkle, 1993) — adds an asymmetry term.
- **EGARCH** (Nelson, 1991) — log-variance, also asymmetric.
- **Student-t innovations** rather than Gaussian, for the fat tails.

Vanilla GARCH will systematically under-forecast the worst days, which is
precisely when sizing matters most.

### 2.4 Practical mismatch with this stack

"60 lines of Python" does not transfer. This project is Node/ESM, serverless on
Vercel, **with no build step** (see the note in `services/riskManager.js:1-16`).
There is no `arch`, no `statsmodels`, no SciPy.

The variance recursion itself is trivial in JS. The **maximum-likelihood fit** is
the awkward part — it needs an optimiser that would have to be hand-written or
vendored, and refit per symbol per timeframe, inside a serverless function with a
cold-start budget.

There is a clean way around this, covered in §5, Step 4.

---

## 3. What the codebase already has (verified)

All references below were read directly.

| Capability | Location | State |
|---|---|---|
| ATR + volatility classification | `lib/advancedIndicators.js:98-141` | Implemented |
| Candle history, multi-provider | `services/marketData.js:436` (`getCandles`, 500 bars, Kraken/Bitfinex/Binance fallback) | Solid |
| Percent-risk position sizing | `public/js/riskManager.js:370` (`calculatePositionSize`) | Solid, well-documented |
| Risk policy constants | `public/js/riskManager.js:48-160` (1% default, 2% ceiling, 6% heat, 4% correlated) | Solid, sourced to Tharp/Elder/Turtle |
| **Adaptive risk layer** | `public/js/adaptiveRisk.js` (2,849 lines) | Sophisticated — see §4.3 |
| Backtest harness | `backtests/btc-4h-backtest.js` | Available for validation |
| Strategy engine | `services/strategy.js` (3,993 lines) | 5 strategies, structural stops |

**This is a well-built system.** The recommendations below are about connecting
existing parts, not replacing them.

---

## 4. The three real gaps

### 4.1 The volatility thresholds are absolute, not relative — **this is a live bug**

`lib/advancedIndicators.js:128-134`:

```js
// Classify volatility state
let volatilityState = 'NORMAL';
if (atrPct < 0.5) {
  volatilityState = 'LOW';
} else if (atrPct > 2.0) {
  volatilityState = 'HIGH';
}
```

These are BTC-daily-shaped constants applied to **every symbol on every
timeframe**. Consequences:

- A mid-cap altcoin on a 5m chart sits above 2% ATR essentially always → the
  classifier returns `HIGH` permanently and carries **zero information**.
- A large-cap on a 5m chart may sit below 0.5% almost always → permanently
  `LOW`, equally uninformative.
- The same asset reclassifies purely by changing timeframe, which is not a
  regime change.

**Fix:** classify against a **percentile of that symbol's own trailing ATR
distribution** on that timeframe — e.g. below the 30th percentile → `LOW`, above
the 70th → `HIGH`, else `NORMAL`. With 500 candles available from `getCandles`,
there is ample history to compute this per request.

This is roughly 30 lines and is worth more than the entire GARCH exercise,
because it is the difference between a working classifier and a constant.

> **Note:** `atr` is rounded via `toFixed(2)` at `advancedIndicators.js:137`.
> That is a display-precision choice which loses meaningful digits for
> low-priced tokens. If ATR starts driving sizing, this rounding must move to
> the presentation layer.

### 4.2 `volatilityState` is dead code

The classifier's output is consumed in exactly two places, both of which only
serialise it into an API response:

- `api/analyze.js:114` — `advancedIndicators.calculateAllAdvanced(...)`
- `api/indicators.js:113` — same

**`services/strategy.js` never reads it.** All 3,993 lines of strategy logic are
volatility-blind. Nothing in the system changes behaviour based on volatility
regime.

That is the actual gap — and it is not a GARCH gap. Adding a better volatility
forecast to a system that ignores the volatility it already has would change
nothing.

### 4.3 `adaptiveRisk.js` adapts to the *trader*, but not to the *market*

This is the most important finding, and it reframes the whole proposal.

`public/js/adaptiveRisk.js` is a genuinely well-designed 2,849-line layer that
answers *"given what this account has actually done, how much should it be
risking right now?"* Its decision hierarchy
(`docs/ADAPTIVE_RISK_ENGINE.md` §1):

```
1. LEVEL              what the account has earned                  (slow)
2. STRATEGY           which preset the user selected
3. CONFIDENCE         the slider — INSIDE the envelope only
4. WALLET PERFORMANCE recent results and drawdown — one-way DOWN
5. OPEN RISK          heat, exposure, concentration, margin clamps
6. NO-TRADE GATE      evaluated last, overrules everything above
```

Every input is **account state**: equity curve, drawdown, win streak, open heat,
directional concentration. Confirmed by inspection of the two entry points:

```js
// public/js/adaptiveRisk.js:1539
calculateStrategyEnvelope({ level, strategy, recentPerformance, drawdown })

// public/js/adaptiveRisk.js:1910 — request shape
{ asset, strategy, confidence, entry, stop, direction, override, now }
```

**There is no market-volatility input anywhere in the layer.** Grepping for
`volatil|atr|regime` across all 2,849 lines returns only two incidental prose
matches in comments.

So the system adapts risk to the trader's recent behaviour but not to the
market's current state. **Volatility regime is the missing axis** — and the
existing envelope architecture already has exactly the right shape to receive
it.

### 4.4 Structural stops already give *implicit* vol-awareness (mostly)

Worth stating so this is not rebuilt unnecessarily: stops are derived from swing
structure (`services/strategy.js:426`, `:518`, `:810`, `:827`, `:2618`, `:2622`).
Wider swings → wider stop → at fixed 1% risk, **automatically smaller position**.

That is the post's core insight, and the system already has it.

The gap is the **fallback paths**, which are fixed percentages and entirely
vol-blind:

```js
services/strategy.js:426   const stopLoss = swingLow15m || swingLow1h || (entry * 0.97);
services/strategy.js:518   const stopLoss = swingHigh15m || swingHigh1h || (entry * 1.03);
services/strategy.js:810   stopLoss = swingLow  ? swingLow  * (1 - buffer) : entryPrice * 0.97;
services/strategy.js:827   stopLoss = swingHigh ? swingHigh * (1 + buffer) : entryPrice * 1.03;
services/strategy.js:2618  stopLoss = Math.min(swingLow15m  || currentPrice * 0.95, swingLow5m  || currentPrice * 0.95);
services/strategy.js:2622  stopLoss = Math.max(swingHigh15m || currentPrice * 1.05, swingHigh5m || currentPrice * 1.05);
```

A hardcoded 3% stop is far too tight in a high-vol regime and needlessly wide in
a calm one. These should be **ATR multiples**.

---

## 5. Recommendations

Sequenced so each step is independently shippable and independently testable
against `backtests/btc-4h-backtest.js`. **Value per line of code descends
strictly down this list.**

### Step 1 — Percentile-based regime classification `[highest value]`

Replace the absolute thresholds at `lib/advancedIndicators.js:128-134` with
percentile ranking against the symbol's own trailing ATR distribution on the
same timeframe.

- Fixes a real bug (§4.1)
- Self-contained, ~30 lines, no new dependencies
- Prerequisite for everything below
- Emit the percentile itself (`atrPercentile`), not just the bucket — downstream
  consumers want the continuous value
- Keep `volatilityState` in the response for backward compatibility

**Also move the `toFixed(2)` rounding out of the calculation** (§4.1 note).

### Step 2 — ATR-multiple stop fallbacks

Replace the six fixed-percentage fallbacks listed in §4.4 with ATR multiples
(e.g. `2.0 × ATR`), retaining structural stops as the primary source.

- Small, local, high confidence
- Do **not** alter the structural-stop path — it already works
- Preserve the engine's stated principle: *"The stop is never moved to fit a
  percentage"* (`adaptiveRisk.js:1905-1908`)

### Step 3 — Volatility haircut in the adaptive envelope `[the real prize]`

Add volatility regime as an input to `calculateStrategyEnvelope`
(`public/js/adaptiveRisk.js:1539`), as a new haircut alongside the existing
performance and drawdown haircuts.

**Critical design constraint — this must be DOWNWARD-ONLY.**

The existing layer already codifies *"Slow up, fast down"* and implements
performance adjustment as a one-way haircut. The volatility haircut must follow
the same rule, for a reason beyond consistency:

> Naive vol targeting — *size up when vol is low* — is the exact mechanism
> behind the February 2018 short-volatility blowup. Low realised vol invites
> maximum size precisely when a vol spike is most damaging. **Elevated vol should
> reduce size; suppressed vol must not increase it.**

This is where the proposal's actual measurable benefit lives, and the existing
architecture accepts it cleanly:

- New optional field on the `recommendTrade` request (`adaptiveRisk.js:1910`),
  e.g. `marketVolatility: { atrPercentile, volatilityState, timeframe }`
- Fold into the envelope as a multiplier `≤ 1`, never `> 1`
- Report it in the existing `factors[]` array so the UI explains the reduction
- **Absent input must be neutral** — `× 1`, matching how the layer already
  treats insufficient-sample performance data (`adaptiveRisk.js:1552-1554`).
  Callers that do not pass volatility must behave exactly as today.
- Add to `hashInputs` (`adaptiveRisk.js:377`) so determinism is preserved
- Bump `STRATEGY_VERSION` (`adaptiveRisk.js:60`)
- Extend `scripts/validate-adaptive-risk.js` (`npm run validate:adaptive`)

The layer's purity contract (no network, no clock, no randomness) means
volatility must arrive **as a parameter**, computed by the caller. Do not fetch
candles inside `adaptiveRisk.js`.

### Step 4 — Better volatility estimator `[optional, lowest priority]`

Only now does GARCH become relevant, and it is a **drop-in replacement for the
estimator feeding Steps 1–3** — not a new capability. Escalate only if the
backtest justifies each rung:

| Rung | Model | Fitting cost | Notes |
|---|---|---|---|
| 0 | Current ATR | none | Baseline |
| 1 | **EWMA** (RiskMetrics, λ=0.94) | **none** | J.P. Morgan (1996). Literally a fixed-parameter GARCH special case (IGARCH with ω=0, α=1−λ, β=λ). ~15 lines of JS. |
| 2 | GARCH(1,1), fixed params | none | e.g. ω small, α≈0.09, β≈0.90. Recursion only. |
| 3 | GJR-GARCH(1,1)-t, fitted | MLE optimiser | Asymmetric + fat tails (§2.3). Only rung needing an optimiser. |

**Start at rung 1.** EWMA captures most of the benefit for zero fitting cost and
no serverless cold-start risk. Realistically, moving from EWMA to a fitted GARCH
buys a single-digit-percent improvement in forecast error.

### Step 5 — Regime as an entry gate `[worth considering]`

The post ignores this entirely, and it may be worth more than the sizing change.

Persistence at 74–81% means the regime **breaks 19–26% of the time** — and
low→high transitions are exactly when short-timeframe setups get run over.
Consider suppressing `MICRO_SCALP` and `SCALP_1H` during volatility expansion,
via the existing no-trade gate (`adaptiveRisk.js:1731`,
`evaluateNoTradeConstraints`) rather than as new logic in `strategy.js`.

---

## 6. Validation plan

**Do not ship any of this on reasoning alone.** `backtests/btc-4h-backtest.js`
exists precisely for this — `npm run backtest:btc4h`. Regression suites:
`npm run validate:adaptive`, `npm run validate:risk`, `npm run validate:all`.

For each step, produce a before/after on identical data:

| Metric | Why |
|---|---|
| Sharpe ratio | The claimed benefit — should improve |
| Max drawdown | The claimed benefit — should shrink |
| Win rate | **Should be roughly unchanged.** If it moves much, something is wrong — sizing must not affect hit rate |
| Total return | May go *down* while Sharpe improves. That is an acceptable and expected outcome |
| Trade count | Should be unchanged for Steps 1–3; will drop for Step 5 |

Test across **at least one high-vol and one low-vol period**, and on **more than
one symbol** — Step 1's entire purpose is correct cross-asset behaviour, and a
BTC-only backtest cannot demonstrate it.

Guard against the obvious failure mode: percentile ranking uses a trailing
window, so ensure the window contains **only data available at that bar**. A
lookahead bug here would make results look excellent and be worthless.

---

## 7. Honest framing for whoever picks this up

- This is a **risk-management upgrade, not an alpha source.**
- It should improve risk-adjusted returns of strategies that are already
  positive-expectancy.
- It **cannot rescue a negative-expectancy strategy**, and if any of the five
  strategies are net-negative, this work will make that clearer rather than fix
  it. That is arguably its most valuable function.
- The system is already better-designed than the source post assumes. The work
  is connective, not foundational.

---

## 8. What was NOT verified — open items

Stated explicitly so none of it is mistaken for established fact:

1. **No backtest was run.** Every claim about expected Sharpe/drawdown impact is
   reasoning from theory, not measurement from this system's data.
2. **Expectancy of the five strategies is unknown to me.** I did not evaluate
   whether `SWING`, `TREND_4H`, `TREND_RIDER`, `SCALP_1H` or `MICRO_SCALP` are
   positive-expectancy. §7 depends on this and it is untested.
3. **The source post could not be retrieved.** `x.com` and mirror hosts are
   blocked by the environment's egress proxy. The assessment in §2 is based on
   text pasted into the session, not the original — engagement, replies and any
   linked material are unreviewed.
4. **SPY figures (74%/81%) were not reproduced.** They are plausible for regime
   persistence but unverified, and the note in §2.2 about the persistence
   baseline applies regardless of whether they are accurate.
5. **Cold-start cost of any fitted model on Vercel was not measured.** This is
   the main practical risk in Step 4, rung 3, and it should be measured before
   that rung is attempted.
6. **`public/js/adaptiveRisk.js` was read selectively**, not in full — entry
   points, envelope, constants and export surface. The claim that it has no
   volatility input rests on a grep across all 2,849 lines (only two incidental
   comment matches), which is strong but not equivalent to a full read.
7. **Deployment is a known pre-existing problem.** Per
   `docs/ADAPTIVE_RISK_HANDOFF.md`, builds on both `main` and the adaptive-risk
   branch were failing as of 2026-08-23, undiagnosed. **That is unrelated to this
   work but will block shipping it.** Resolve it first.

---

## 9. References

- Engle, R. (1982). *Autoregressive Conditional Heteroscedasticity with Estimates
  of the Variance of United Kingdom Inflation.* Econometrica 50(4).
- Bollerslev, T. (1986). *Generalized Autoregressive Conditional
  Heteroskedasticity.* Journal of Econometrics 31(3).
- Nelson, D. (1991). *Conditional Heteroskedasticity in Asset Returns: A New
  Approach.* Econometrica 59(2). [EGARCH]
- Glosten, L., Jagannathan, R. & Runkle, D. (1993). *On the Relation between the
  Expected Value and the Volatility of the Nominal Excess Return on Stocks.*
  Journal of Finance 48(5). [GJR-GARCH]
- J.P. Morgan/Reuters (1996). *RiskMetrics Technical Document*, 4th ed. [EWMA, λ=0.94]
- Hansen, P. R. & Lunde, A. (2005). *A forecast comparison of volatility models:
  does anything beat a GARCH(1,1)?* Journal of Applied Econometrics 20(7).
- Corsi, F. (2009). *A Simple Approximate Long-Memory Model of Realized
  Volatility.* Journal of Financial Econometrics 7(2). [HAR-RV]

Internal:
- `docs/ADAPTIVE_RISK_ENGINE.md` — the layer this work extends
- `docs/ADAPTIVE_RISK_HANDOFF.md` — deployment state, §7 item 7
- `docs/BACKTEST_GUIDE.md` — validation harness
- `docs/INDICATOR_INTEGRATION_CHECKLIST.md` — follow for Step 1
