# EditTrades — agent orientation

A BTC/crypto trade **decision desk**. It reads market data, evaluates strategies,
sizes positions against what the account has earned the right to risk, and tells
a human what to trade. **It does not place trades.** Execution is disabled and
the user acts externally.

Production: `https://snapshottradingview.vercel.app` (auto-deploys from `main`)

> **Read `docs/ARCHITECTURE.md` next.** It has the diagrams. This file is the
> set of things that will cost you an afternoon if you don't know them.

---

## Read this before you touch anything

### 1. There is no build step

`public/**` is served verbatim as static files. That means:

- **`services/`, `lib/` and `api/` are server-only.** A browser file can never
  import from them. Code needed on both sides is duplicated deliberately (see
  `services/riskManager.js`, which is a re-export shim explaining exactly this).
- Browser modules live in `public/js/` and are plain ESM loaded by `<script type="module">`.
- No bundler, no transpiler, no TypeScript, no JSX. Write ES2022 that a browser runs as-is.

### 2. The Vercel function budget is FULL

`vercel.json` declares **exactly 12** `@vercel/node` builds. The Hobby plan caps
a deployment at 12. **Adding a 13th fails the whole deployment** with
`exceeded_serverless_functions_per_deployment` — this has broken production before.

To add an endpoint you must remove or merge one. Note several files in `api/`
exist but are **not** in `vercel.json` and therefore do not deploy
(`analyze-full.js`, `parse-trade-image.js`, `review-trade.js`,
`wallet-portfolio.js`, `wallet-trades.js`).

This is why `public/js/btcDecisionDesk.js` runs in the browser rather than as an
endpoint.

### 3. Confidence is 0-100. Everywhere.

Not 0-1. Comparing a threshold of `0.5` against it makes the filter inert — that
was a real bug in the scanner. If you see a confidence compared against a
fraction, it is broken.

### 4. Swing levels live on `structure`, not on `indicators`

```js
analysis['4h'].structure.swingLow   // ✅ correct
analysis['4h'].indicators.swingLow  // ❌ undefined — always
```

Twelve call sites got this wrong, and because they read
`swingX || swingY || (entry * 0.97)`, the hardcoded 3% fallback became
**unconditional** while the real level sat unread on the same object. Use the
`swingLevel(tf, side)` helper in `services/strategy.js`.

### 5. Missing evidence forfeits its weight — callers must supply macro timeframes

Confidence weights macro 40%, primary 35%, execution 25%. A layer with **no
data** contributes **zero** rather than scoring as if it agreed. Therefore:

**Any caller that omits `1d`/`3d` caps a STANDARD signal below every admission
gate and gets nothing.** Verified: 0 signals on `4h/1h/15m/5m`, 3 with `1d/3d`
added. `scripts/validate-strategy-safety.js` §7 pins this.

### 6. `public/js/adaptiveRisk.js` is PURE and must stay that way

No network, no `Date.now()`, no `Math.random()`. `now` is always a parameter.
`scripts/validate-adaptive-risk.js` scans the source for clock and randomness
calls and fails if you add one. Same contract for `public/js/btcDecisionDesk.js`.

### 7. Never let missing data become a usable value

This codebase has been bitten repeatedly by absent inputs silently reading as
neutral or permissive. The rule now:

- Absent market data → **no trade**, never a fabricated candle or price.
- Absent risk state → **blocked**, never `{allowed: true}`.
- Absent evidence → **zero points**, never a 1.0 multiplier.
- No structural level and no ATR → **`null` stop**, never `entry * 0.97`.

A stop sets the position size, so inventing one is fabricating a risk figure.

### 8. Do not run `scripts/transfer-funds.js`

It contains live Solana private keys in plaintext, in a public repo. It is an
open operator issue (`docs/BTC_DECISION_DESK_STATUS.md` §1.1). Do not execute it,
do not copy the keys, and do not attempt to purge history — that needs a
force-push and is the owner's call.

---

## Commands

```bash
npm start                      # local server on :3000
npm run dev                    # same, with --watch

npm run validate:all           # every suite. START HERE.
npm run validate:adaptive      # adaptive risk engine     (275 assertions)
npm run validate:risk          # base risk manager        (114)
npm run validate:orchestrator  # BTC decision desk        (53)
npm run validate:strategy-safety  # strategy invariants   (32)
npm run validate:volatility    # ATR regime classifier    (31)

npm run backtest:btc4h         # needs BACKTEST_CSV_* offline (see below)
```

**`validate:all` reports network suites as SKIPPED, not passed.** A skipped suite
verified *nothing*. Do not read the summary as full coverage.

**Every exchange host is 403 at the egress proxy in CI** (Kraken, Binance,
Bitfinex, CoinGecko, Coin Metrics, and every alternative tried). So:

- Offline suites are the real signal.
- The backtest needs CSVs: `BACKTEST_CSV_4H`, `_1H`, `_15M`, `_5M`, `_1D`, `_3D`.
- `raw.githubusercontent.com` and `registry.npmjs.org` **are** reachable.

---

## Where things live

| Layer | Path | Notes |
|---|---|---|
| Market data | `services/marketData.js` | Kraken → Bitfinex, provenance-stamped |
| Indicators | `services/indicators.js`, `lib/advancedIndicators.js` | EMA, StochRSI, ATR, swings |
| Strategy engine | `services/strategy.js` (4.4k lines) | The big one. 7 signal producers. |
| Risk — base | `public/js/riskManager.js` | Static percent-risk maths |
| Risk — adaptive | `public/js/adaptiveRisk.js` (3k lines) | Level ladder, envelopes, haircuts |
| BTC card decision | `public/js/btcDecisionDesk.js` | Pure. Shows/hides the trade card. |
| Trade card UI | `public/index.html` | CSS + markup + controller in the module block |
| Tracked trades | `public/tracker.html` | The live trade store |

---

## Traps that are not obvious from the code

**Three separate trade stores exist**, with three status vocabularies. Only
`tracker.html` → Firestore `trades` has a live writer. `riskStoreLegacy`'s
planned-trades store has a strict schema and **zero writers**. Do not revive it;
do not add a fourth. See `docs/ARCHITECTURE.md`.

**`firestore.rules` is committed but NOT deployed**, and it denies the root
`trades` collection — the one the tracker uses. Deploying it takes Tracked
Trades offline and the fallback silently persists an empty array over the
history.

**Three different things are called `confidence`**: the strategy engine's score,
`htfBias.confidence` (an agreement *ratio*, not a probability), and a manual
0-100 slider on the risk page. They are unrelated.

**`public/index.html` has a second, parallel confidence model** on a 0-1 scale
that never touches the backend.

**These modules are production-dead** — imported only by test scripts, despite
looking central: `services/decisionContext.js`, `services/systemHealth.js`,
`services/strategy-refactored.js`. `lib/confluenceScoring.js` is display-only and
never feeds a decision.

**`strategy_logic_export/`** is a stale copy of `services/` that still contains
the deleted synthetic-data generator and hardcoded `$50,000` price defaults. It
does not deploy. Do not import from it; do not grep it for current behaviour.

**Candle arrays include the still-forming bar** on every provider, and nothing
drops or flags it. Only `lib/levels.js` handles close-confirmation correctly.
Indicators repaint intra-bar.

**Provenance rides on the candle array as a non-enumerable property**, so it is
lost by `.map`/`.slice`/`JSON.stringify` — and it is lost on every production
path, because the API layer discards the array and keeps only the indicators.

---

## Conventions

- **ESM everywhere** (`"type": "module"`). Named exports, plus a default object
  re-exporting them in the larger browser modules.
- **Comments explain WHY**, not what. Several modules carry long rationale
  comments recording why a constant is what it is, or why a defect was fixed a
  particular way. Match that density — this codebase's history is full of
  plausible-looking values that turned out to be invented, so provenance matters.
- **Constants that are guesses say so** and are exported rather than inlined, so
  they can be swept in a backtest. `ATR_STOP_FALLBACK_MULTIPLE` and
  `VOLATILITY_HAIRCUT_TIERS` are both explicitly unvalidated starting hypotheses.
- **Tests are plain scripts**, no framework. `ok(name, condition, detail)` plus a
  section header, exit 1 on failure. Add to `scripts/validate-all.js`'s `SUITES`.
- **A test that passes before and after a fix proves nothing.** Verify a new
  regression test actually fails against the unfixed code, and say so in the
  commit message.

---

## Current state

Live work is on `integration/btc-autonomous-decision-desk` (PR #5, unmerged).

**`docs/BTC_DECISION_DESK_STATUS.md` is the honest status.** It carries a claim
ledger separating what was reproduced from what was inferred, and eight things
explicitly NOT verified. Read §4 before trusting a confidence number: it is
decomposable and checkable now, but **uncalibrated** — the constants were picked,
not fitted, and cannot be fitted without market data.

Treat handoff docs as dated. Where a doc and the code disagree, **the code is
authoritative** — two docs in `docs/` have already been wrong about their own
work, and both corrections are recorded in the status doc §2.
