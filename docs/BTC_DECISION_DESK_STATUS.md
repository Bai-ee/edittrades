# BTC Autonomous Decision Desk — Status and Handoff

**From:** the lead engineering agent
**Branch:** `integration/btc-autonomous-decision-desk`
**Base SHA:** `95fce60097f3d9d3656fa249380a3e78afcb20ea` (`origin/main`)
**Head SHA:** `50da119c56eb4700063262a2697113a082ad5017`
**Date:** 2026-08-24
**Status:** **PR open for review. Definition of Done still NOT fully met — see §4.**

> **Update (second pass).** The owner reviewed the findings below and directed:
> fix what is still broken, keep it simple enough for a junior dev, open a PR,
> and build the trade card anyway. All four were done. §3.7 records the second
> pass; §4 has been narrowed to what genuinely remains.

---

## 0. The one-line verdict

Seven independent audits established that the engine underneath the trade card
would confidently recommend trades it had no basis for. Several of those
defects were reproduced, not inferred.

This branch fixes every one of them that is provable, then builds the card on
top of the fixed engine. The card exists and is tested in a real browser.

**What remains is not a defect list, it is a measurement problem.** The
confidence number the card displays is still uncalibrated — the constants
behind it were picked, not fitted — and it cannot be calibrated in this
environment because every market-data provider is blocked. The harness that
would do the fitting now works; it just has nothing to eat. Read §4 before
trusting a confidence figure on the card.

---

## 1. URGENT — operator action, not engineering

### 1.1 Live Solana private keys are in a PUBLIC repository

**VERIFIED, and this escalates a previously-open question to its worst case.**

- `scripts/transfer-funds.js:14` and `:18` contain two base58 Solana private
  keys at HEAD of `main`, with their matching addresses labelled beside them.
  One is described in-source as the **current trading wallet**
  (`JEAzPiuEheUQkK5Q1TLgm7VzuuZHDTzFu1oUwQgTjwT2`).
- `docs/WORK_AUDIT_HANDOFF.md` §9 left open *"Whether `Bai-ee/edittrades` is
  public. Determines whether B-1 is 'the internet has these keys' or
  'collaborators and clones do'."*
- **It is public.** Vercel deployment metadata reports
  `githubRepoVisibility: "public"` on every deployment.

**Move the funds out of both wallets first.** Purging history and rotating keys
is worthless if the balance is already gone. GitHub is continuously scraped for
exactly this pattern. Purging requires a force-push, which is the operator's
call and which the brief forbids agents from doing.

### 1.2 Deploying `firestore.rules` will take Tracked Trades offline

`firestore.rules:69-71` sets the root `trades` collection to
`allow read, write: if false`. That is precisely the collection
`public/tracker.html` reads and writes. The file's own header says it has not
been deployed.

On `firebase deploy --only firestore:rules`, the tracker falls back to
per-browser `localStorage` via the catch at `tracker.html:1418-1422`. That
fallback returns `[]`, and the next `saveTrades()` persists the empty array —
**history appears erased**. Decide this before shipping anything that writes
there.

---

## 2. Corrections to earlier documents

`docs/ADAPTIVE_RISK_HANDOFF.md` is stale in a way that matters:

| Doc claim | Verified reality |
|---|---|
| "Every deployment of this branch has FAILED"; "`main` is currently also failing" | **False now.** `main` @ `95fce60` deployed **READY** to production (`dpl_HjvTkmQUFysZP3QcEYCn5xxVtghu`). Root cause was `exceeded_serverless_functions_per_deployment`, fixed at `8e39b23`. |

`docs/VOLATILITY_REGIME_HANDOFF.md` §4.4 (written earlier in this same session)
is **wrong** and is corrected here:

> It said structural stops "already give implicit vol-awareness" and that only
> the fallback paths were volatility-blind.

On four strategies the structural read was a **dead field path** — see §3.3. The
fallback was not a rare fallback; it was the only outcome.

**PR #3 is open but orphaned.** Its base `integration/adaptive-risk-prod` was
already merged, so it targets a dead base. It should be closed, not merged.

---

## 3. What this branch fixed

Six commits. All offline suites pass. Every fix below was reproduced before it
was made.

### 3.1 The risk engine could be talked past its own limits

**`override.leverage` bypassed the leverage cap.** Assigned verbatim with no
clamp; the only downstream leverage check is guarded by
`margin > marginBudget`, and raising leverage *shrinks* margin, so a high pin
skipped the guard entirely.

```
recommendTrade(..., override: { leverage: 50 })
  -> decision TRADE, position.leverage 50, envelope.maxLeverage 3,
     blockers [], warnings [], factors []
```

Indistinguishable from a genuine 50x recommendation, with a liquidation estimate
computed at 50x to match. Now clamped, with a `LEVERAGE_CAP` factor and warning.

**The last-resort no-trade gate permitted by default.**
`evaluateNoTradeConstraints` substituted an empty book for absent state and
guarded five of seven blockers behind `if (envelope && ...)`:

```
evaluateNoTradeConstraints({ adjustedEquity: 25000 })
  -> { allowed: true, blockers: [] }
```

An unconditional permission manufactured from the absence of evidence. Now
returns `INCOMPLETE_STATE`. Non-finite fields are rejected too — every threshold
is `value >= limit`, and `NaN >= limit` is false, so a corrupt book passed
everything silently.

### 3.2 Validation was routed past on four of seven signal producers

`validateStrategySignal` had exactly one caller. SWING, TREND_RIDER,
AGGRO_SCALP_1H and the AGGRESSIVE forced signals never reached it.

Observable in a single response on identical data: TREND_4H was correctly
rejected with *"long trade stopLoss >= entryZone.min"* while **TREND_RIDER
shipped that same inverted geometry as a valid LONG at 84% confidence and won
`bestSignal`** — stop `108673` above entry `108392`, both targets *below* entry,
`riskAmount` negative, `riskReward` displayed as 2.0.

Every producer now validates. The validator was also extended: it previously
compared the stop to the entry zone and never looked at the targets or
established that R > 0.

### 3.3 "Structural" stops that were silently hardcoded percentages

Swing points live at `structure.swingHigh/swingLow`. **Twelve reads across four
strategies** asked for `indicators.swingLow` — a field the indicator payload
does not contain.

```js
const swingLow15m = parseFloat(tf15m.indicators?.swingLow);  // NaN, always
const stopLoss = swingLow15m || swingLow1h || (entry * 0.97); // -> 3%, ALWAYS
```

The user was told the stop was anchored to the 15m swing low while the real
level sat unread on the same object. All twelve now read `structure` through one
helper. Where no structural level exists the fallback is an ATR multiple, not a
percentage. Where neither exists it returns `null` and the caller does not
trade — inventing a stop is fabricating a risk level, which this codebase
already refuses to do for market data.

`resolveStop` also **discards a structural level on the wrong side of entry** —
the root cause of §3.2, since `detectSwingPoints` returns a rolling 20-bar
extreme rather than a confirmed pivot, so a "swing low" can sit above price.

### 3.4 Absent evidence scored identically to perfect evidence

Every missing confidence layer defaulted to a `1.0` multiplier — the same value
as perfect alignment — so a **total market-data blackout produced a fully
specified SWING signal at confidence 80**, clear of its own 60 gate.

Absent layers now forfeit their weight. This needs no new constant: the existing
0.40/0.35/0.25 hierarchy already says what each layer is worth.

| Evidence available | Before | After |
|---|---|---|
| Nothing | 80 | **0** |
| 4h + 1h only | 80 | **28** |
| All layers aligned | 80 | **81** |

Complete evidence is unchanged. Only missing evidence is penalised, and only
downward.

### 3.5 Other reproduced defects fixed

- **SCALP_1H threw on every evaluation.** A `const htfBias` re-declaration put
  an earlier read in the temporal dead zone. The `ReferenceError` was caught,
  rewritten to "Internal error", then to "No trade setup available" — a
  permanently broken strategy reported as a clean no-setup.
- **MICRO_SCALP cleared its own gate by construction.**
  `Math.max(60, Math.min(75, …))` floored confidence at exactly its 60 pass
  threshold. A floor must reject, never clamp upward.
- **SWING's overextension gate was a tautology.** `(dist < -8 || dist > -15)` is
  true for every real number; identical signals were produced at 3D distances of
  −30%, −0.1% and +37.5%.
- **The exhaustion penalty was dead code** — computed, displayed to the user as
  a 30% penalty, never applied. Real cost was about two points.
- **Volatility was classified against absolute ATR thresholds** (0.5% / 2.0%)
  applied to every symbol and timeframe, so the classifier saturated and carried
  no information. Now percentile-ranked against the symbol's own trailing
  distribution.
- **Market volatility now reduces risk capacity** via a downward-only envelope
  haircut. There is no tier below the 70th percentile: a calm market earns
  nothing. Absent input is exactly neutral.

### 3.6 Test coverage added

| Suite | Assertions | Command |
|---|---|---|
| Volatility regime | 31 (new) | `npm run validate:volatility` |
| Strategy safety | 30 (new) | `npm run validate:strategy-safety` |
| Adaptive Risk | 247 → **275** | `npm run validate:adaptive` |

Both new suites are registered in `validate:all`, which also now runs the
adaptive suite that was never wired into it.

**The strategy suite is verified discriminating**: reverting
`services/strategy.js` makes its geometry assertions fail with the exact
inverted-stop payload quoted in §3.2. A test that passes before and after a fix
proves nothing, and this one does not.

---

### 3.7 Second pass — the remaining fixes, and the card

**The backtest harness now produces trades.** Two API-drift bugs (wrong
argument order, wrong result shape) meant it returned zero on any input, so
every number it had ever printed was zero. It also discarded the strategy's own
stops and targets, hardcoding every trade to ±1R. Both fixed, costs now actually
applied, metrics added including performance bucketed by confidence — the one
that says whether confidence means anything. An offline CSV path was added
because ccxt cannot reach any exchange from here.

**REDUCE no longer buys more of the asset.** The fix is a refusal rather than a
corrected swap: this desk executes spot swaps with no borrowing, so a tracked
SHORT has no position a further swap can reduce, and the accounting is wrong for
shorts as well. Selling and adding are now blocked for non-LONG with a message
saying why. Inventing a close-short path would mean inventing execution
semantics that do not exist.

**"I MADE THIS TRADE" is idempotent**, and trade ids no longer collide — they
were `Date.now()`, and the tracker writes Firestore docs keyed by id, so a
same-millisecond collision overwrote rather than duplicated.

**The P&L feedback loop is closed** — with one honest limit. The risk figure the
engine sized was already stored and simply never handed back; it now is. The
matcher that does the handing back could also never match, because it compared a
ticker against a base58 mint. That is fixed too, but **BTC and ETH still cannot
match**, because this repo contains no verified wrapped-asset mint on Solana and
a wrong link would corrupt the very loop this fixes. See §4.3.

**Confidence is now decomposable** — the rows on the card sum to the score,
verified across ten evidence and cap combinations. This makes the number
*checkable*. It does not make it *calibrated*; see §4.1.

**The card is built** (`public/js/btcDecisionDesk.js` plus the sheet in
`public/index.html`). It runs in the browser on the existing
`/api/analyze-full` payload, so it adds no serverless function. It fails closed
at every gate and names a reason each time. The quality floor is a frozen
constant that volatility, drawdown and degraded inputs can only raise.

Two regressions of my own, found by re-reading the diff against every caller
rather than only the one I was editing, are recorded here because they are the
kind of thing that ships silently:

- Making absent evidence forfeit its weight would have made **the scanner return
  nothing** — it requested only `4h/1h/15m/5m`, and without the macro layer a
  STANDARD signal caps below every admission gate. Measured: 0 signals before,
  3 after adding `1d/3d`. A test now pins the requirement.
- `.rm-mini-btn` and `.rm-details` are defined in **risk.html's page-local**
  stylesheet, so on `index.html` the card's own controls had no styling and
  none of their 44px minimums — measured 21px and 16px. Only the browser run
  caught this; no unit test could have.

---

## 4. What still cannot be done here

### 4.1 Hard environmental blocker — no market data

**Every** exchange and data provider is blocked at this environment's egress
proxy with `403 at CONNECT` — a policy denial, not a fault:

`api.kraken.com` · `api.binance.com` (+ `.us`, `data.`) · `api-pub.bitfinex.com`
· `api.coingecko.com` · `community-api.coinmetrics.io` · `api.dflow.net` ·
Coinbase · Bybit · OKX · KuCoin · Gate · Bitstamp · Gemini · CryptoCompare ·
Yahoo Finance · Nasdaq

Consequently these DoD items **cannot be satisfied here at all**:

- historical backtest completed
- out-of-sample validation completed
- confidence calibration evaluated

Partial workaround found: `raw.githubusercontent.com` *is* reachable, and real
BTC/USD hourly data exists there for **2013-01 → 2017-08** (~10,139 4h bars,
Bitstamp-derived, 11% of rows encode missing data as `1.7e+308` and must be
filtered). That is enough for a degraded 4h+1h evaluation. It provides **no 15m
or 5m data at any date**, nothing after 2017, and no funding history — so the
strategy's lower-timeframe confirmation legs cannot be exercised at all.

### 4.2 Confidence is decomposable but still not calibrated — FIXED IN PART

The card's confidence rows now sum to the score, so the number is checkable.
Nobody has checked it. The constants behind it — the per-strategy base values,
the 0.40/0.35/0.25 layer weights, every ±3 and ±5 — were picked, not fitted, and
there is still no reliability curve anywhere in the repo.

The harness that would produce one now works and buckets results by confidence
band. It has nothing to eat (§4.1). **Until it does, treat "78" as an ordering,
not a probability** — it is useful for ranking two setups against each other and
not for deciding how much to risk.

### 4.3 The BTC feedback loop is closed everywhere except BTC

The realised-P&L loop now writes the engine's own risk figure back onto matched
trades, so the level ladder can move. But the matcher links a recommendation to
an on-chain Solana trade by asset, and **there is no verified wrapped-BTC mint
in this repo** — `services/tokenMapping.js` carries its BTC and ETH entries with
a literal `TODO: verify` comment.

So on a BTC-only desk, a BTC recommendation still cannot link to an execution.
The failure mode is safe (it stays `WATCHING`, never a false link) but it means
**the learning loop does not yet close for the asset the card recommends**. One
verified mint address fixes it; guessing would corrupt the ladder silently,
which is why it was left open.

### 4.4 What the card deliberately does not do — FIXED IN PART

REDUCE and ADD no longer act on shorts; they refuse, because the execution model
cannot express them (§3.7). The card does not surface ADD, REDUCE or PROTECT
PROFIT at all. `PROTECT PROFIT` remains advisory-only with no implementation —
`tradeExecution.js:236` throws `Not Implemented`, and no stop is stored on any
record after creation.

The card is a recommendation surface. Managing an open position is still done by
hand in the tracker.


### 4.5 Function budget is at zero headroom

`vercel.json` declares exactly **12** `@vercel/node` builds and Vercel confirms
`lambdaRuntimeStats: {"nodejs":12}` on the last green deploy. §53 sets 12 as a
release invariant, so **the orchestrator cannot have its own endpoint** — it
must reuse an existing function. (`api/analyze-full.js`,
`api/parse-trade-image.js`, `api/review-trade.js`, `api/wallet-portfolio.js` and
`api/wallet-trades.js` exist on disk but are not deployed.)

---

## 5. Recommended sequence from here

1. **Operator: move the wallet funds** (§1.1), then decide the Firestore rules
   question (§1.2). Neither is engineering.
2. **Feed the backtest harness.** It works now and is the only thing standing
   between the card's confidence number and a calibrated one. Either allowlist
   one exchange host at the egress proxy, or drop Binance public-data CSVs into
   the repo and run with `BACKTEST_CSV_*`. Then sweep, in this order, the three
   constants this branch shipped as explicit starting hypotheses: the
   confidence weights, `ATR_STOP_FALLBACK_MULTIPLE`, and
   `VOLATILITY_HAIRCUT_TIERS`.
3. **Verify one wrapped-BTC mint address** and add it to `KNOWN_MINTS` in
   `riskPage.js` (§4.3). One line, and the learning loop closes for BTC.
4. **Then** consider ADD / REDUCE / PROTECT on the card — but only after the
   execution model can express them for shorts, which today it cannot.


## 6. Claim ledger

**VERIFIED — reproduced or executed by me directly:** the leverage bypass and
its clamp; the empty-state gate and its refusal; the inverted TREND_RIDER
geometry and that the new suite catches it on revert; the dead swing field
paths; confidence 80 → 0 / 28 / 81; `validateStrategySignal` having exactly one
caller; the SCALP_1H TDZ line pair; the SWING tautology; the MICRO_SCALP floor;
the volatility haircut table; the repo being public; the keys at HEAD; the
Firestore `trades` rule; the REDUCE direction inversion and its mapping in
`tradeExecution.js`; the 12-function cap; all suite results quoted here.

**VERIFIED BY AGENTS, spot-checked but not independently re-run by me:** the
backtest harness producing 0 vs 683 signals; the 2013-2017 dataset's row counts
and corruption; the full provider-reachability matrix; the tracked-trade store
inventory; the design-token inventory.

**NOT VERIFIED — do not treat as established:**

1. **No backtest was run.** Every statement about expected Sharpe, drawdown or
   expectancy impact is reasoning, not measurement.
2. **Expectancy of the five strategies is unknown.** If any are
   negative-expectancy, this work exposes that rather than fixing it.
3. **Browser QA covers the trade card only.** 72 programmatic checks at
   320/375/390/430/768/1024 in a real touch Chromium — overflow, tap targets,
   figures rendered, Escape dismissal. `/api/analyze-full` was STUBBED with a
   fixture, because no provider is reachable. **The card has never been driven
   against live market data.** No other page was re-QA'd on this branch.
4. **The full "I MADE THIS TRADE" round trip was not exercised end to end.**
   The card writes the payload and the tracker's intake was fixed to be
   idempotent, but the two halves were tested separately, not as one flow in a
   browser.
5. **The ATR fallback multiple (2.0) and the volatility tier table
   (70/80/90 → 0.90/0.75/0.60) are unvalidated starting hypotheses.** Both are
   exported rather than inlined specifically so they can be swept once step 2
   makes that possible.
6. **Fixing the dead field paths changes live behaviour.** Stops that were
   silently 3% literals are now structural. This is a correctness fix, but it is
   a behaviour change on production paths with no backtest behind it.
7. **The confidence change is a real tightening.** A payload missing macro and
   execution layers now scores 28 and cannot trade. That is the intended
   failure mode — capital preservation over trade frequency — but it means a
   partial provider outage now suppresses trades that previously fired.
8. **MICRO_SCALP and SCALP_1H remain effectively non-functional.** The TDZ crash
   is fixed and MICRO_SCALP's swing reads are repointed, but MICRO_SCALP still
   reads `.pullback`, `.stoch`, `.ema21` and `.currentPrice` at paths that do
   not exist, so its guard returns early. **Deliberately left dead**: switching
   on a strategy that has never once executed, with no backtest available, is
   not a change to make as a side effect of a bug fix.
