# BTC Autonomous Decision Desk — Status and Handoff

**From:** the lead engineering agent
**Branch:** `integration/btc-autonomous-decision-desk`
**Base SHA:** `95fce60097f3d9d3656fa249380a3e78afcb20ea` (`origin/main`)
**Head SHA:** `e8ab19b3942ae37114d44325dd282af76a9c6b0a`
**Date:** 2026-08-24
**Status:** **NOT SHIPPABLE. Definition of Done NOT met. No PR opened.**

---

## 0. The one-line verdict

The autonomous BTC trade popup **must not be built on this engine yet**, and the
reason is not that the popup is hard. It is that seven independent audits
established the engine underneath it will confidently recommend trades it has no
basis for — and several of those defects were reproduced, not inferred.

This branch fixes the defects that are provable and surgical. It does not build
the popup, because doing so would put a one-tap "I MADE THIS TRADE" button on
top of a confidence number that is not statistically meaningful and a trade
lifecycle that can invert a reduction into an increase.

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

## 4. Why the Definition of Done cannot be met

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

### 4.2 The backtest harness has never produced a trade

Independent of the data problem, `backtests/btc-4h-backtest.js` is broken by API
drift and returns **zero trades on any input**:

1. **Wrong argument order.** It calls
   `evaluateStrategy(indicators4h, indicators1h, indicators15m, indicators5m)`;
   the real signature is
   `evaluateStrategy(symbol, multiTimeframeData, setupType, mode)`. The 4h
   indicators land in `symbol`, so `multiTimeframeData['4h']` is `undefined` and
   the function short-circuits on every call.
2. **Wrong result shape.** It reads `.valid` / `.direction` / `.confidence` at
   the top level; they live under `.signal`. So `!signal.valid` is always true
   and it `continue`s on every bar.

Measured on real 2013-2017 BTC data: **0 valid signals** as the harness calls
it, **683** when called correctly.

It also crashes before writing results (`backtests/results/` does not exist, no
`mkdirSync`), declares `slippage` and `commission` and **applies neither**,
hardcodes every trade to exactly ±1R (so profit factor collapses to
`wins/losses` and every "tail loss" metric is degenerate), and discards the
strategy's own stops and targets in favour of its own.

**Every number this harness has ever printed was zero trades.** Any prior tuning
that assumed otherwise is unfounded.

### 4.3 Foundational rework the DoD assumes is already done

- **Confidence is not statistically meaningful.** It is a strategy-name lookup
  (`SWING → 80`) times a narrow weighting, nudged by hand-picked ±2/±3/±5
  constants. Not one constant is derived, cited, or validated. There is **zero
  calibration data in the repo**. §7 of the brief calls for a rebuild; that is a
  substantial piece of work and it is a prerequisite for the dynamic
  tradeability threshold, not a follow-on.
- **There is no single Tracked Trades system.** There are three disjoint stores
  with three status vocabularies. The one with a live writer (`tracker.html` →
  Firestore `trades`) has no schema version and no validation; the one with the
  strict schema (`riskStoreLegacy`) has **zero writers**.
- **The closed-trade feedback loop is a GAP, not a wiring bug.** `riskAmount`
  is never written back from a matched recommendation, so every reconstructed
  trade reads as 0R, all trades are scratches, win rate reads 0 and consistency
  reads 100. The level ladder is effectively frozen on real data. The fix is
  small and identified (`riskPage.js:1737-1746`), but it is untested work.
- **`recommended` vs `actual` can never match.** The matcher compares
  `record.asset` (a user-typed ticker like `"BTC"`) with `trade.asset` (a base58
  mint address). `matchState` stays `WATCHING` forever.

### 4.4 The popup's own actions sit on broken executors

If the popup exposes ADD or REDUCE, these must be fixed first:

- **REDUCE on a short BUYS MORE.** `tracker.html:3412` sends
  `direction: trade.direction === 'LONG' ? 'short' : 'long'`. For a tracked
  SHORT that is `'long'`, and `tradeExecution.js:105-110` maps `'long'` to *buy
  the base token with USDC*. The record is then decremented while the wallet
  holds more. (Latent today: execution is disabled and the auth header is
  missing — but it is one flag away.)
- **ADD leaves stop, targets and `riskPercent` untouched** while doubling the
  position, so every R-multiple in the app is wrong afterwards and targets fire
  on the enlarged position at levels computed for the original entry.
- **PROTECT PROFIT has no implementation at all** — advisory only, and
  `tradeExecution.js:236` throws `Not Implemented`.
- **`"I MADE THIS TRADE"` has no idempotency.** `tracker.html:1095` is a bare
  `trades.push`. Two taps produce two tracked trades for one execution. Ids are
  `Date.now()`, so a same-millisecond collision silently overwrites instead.

### 4.5 Function budget is at zero headroom

`vercel.json` declares exactly **12** `@vercel/node` builds and Vercel confirms
`lambdaRuntimeStats: {"nodejs":12}` on the last green deploy. §53 sets 12 as a
release invariant, so **the orchestrator cannot have its own endpoint** — it
must reuse an existing function. (`api/analyze-full.js`,
`api/parse-trade-image.js`, `api/review-trade.js`, `api/wallet-portfolio.js` and
`api/wallet-trades.js` exist on disk but are not deployed.)

---

## 5. Recommended sequence from here

Ordered so each step is shippable and testable on its own. Steps 1-3 need no
market data and can be done in this environment.

1. **Operator: move the wallet funds** (§1.1), then decide the Firestore rules
   question (§1.2).
2. **Fix the backtest harness** (§4.2). It is roughly a 10-line signature fix
   plus an offline CSV loader. Without it nothing else can be measured, and it
   currently blocks confidence calibration, the ATR-multiple sweep, and the
   volatility tier table — all three of which are shipped on this branch as
   explicitly unvalidated starting hypotheses.
3. **Close the P&L feedback loop** (§4.3) — `riskPage.js:1737-1746`, and fix the
   ticker-vs-mint asset key.
4. **Rebuild confidence additively** (§7 of the brief), using the factor set
   Agent D mapped to modules that already produce the data. Only then does a
   dynamic tradeability threshold mean anything.
5. **Unify the tracked-trade store**, add an idempotency key, and fix the
   REDUCE direction inversion — before any one-tap surface writes to it.
6. **Then** build the orchestrator and popup. The design work is done: Agent H's
   audit gives a complete token/component inventory, and `risk.html:822-871`'s
   `.rm-sheet` is the established bottom-sheet pattern to reuse (it needs
   Escape, backdrop-dismiss and focus management added).

---

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
3. **No browser was used.** No mobile QA was performed on this branch. Chromium
   and Playwright are available in this environment; the harness described in
   `docs/MOBILE_QA.md` lives in an expired session's scratchpad and would need
   rebuilding.
4. **No Vercel preview was validated for this HEAD.** §61's exact-SHA release
   gate is unsatisfied.
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
