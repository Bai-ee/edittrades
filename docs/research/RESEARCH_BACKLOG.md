# Research backlog — parked work for later review

Research-only. Nothing here is approved for implementation. Every item waits for a full review of the work done, then an explicit go per item.
One card per strategy study. Add new studies as new cards; keep verdicts and negative results.

Status keys: `DONE` (evidence exists), `PARKED` (scoped, not started, needs approval), `BLOCKED` (named dependency), `DROPPED` (with reason).

---

## Card 1 — EXTERNAL_4H_SMA200_V1 (4H SMA200 long/flat)

- **Study doc (full results, registration, examples):** [EXTERNAL_4H_SMA200_STATUS.md](./EXTERNAL_4H_SMA200_STATUS.md)
- **Branch / worktree:** `edge-external-4h-sma200` at `../snapshot_tradingview-edge-sma200`, base `bd01c2f`. Not pushed, not merged.
- **Date:** 2026-09-27
- **Verdict:** PAPER CANDIDATE for spot long/flat. REJECT on perps.

### What it is

Long when the closed 4H close is above SMA200, otherwise flat. No shorts, stops or targets. The decision is made at the bar close and filled at the next bar open.
The idea comes from public trend-following research. `0xrikt/crypto-skills` @ `360c5e2` was used only to check implementation semantics.

### What we learned (S3, 0.15% per side)

| | Strat CAGR | B&H CAGR | Strat maxDD | B&H maxDD | Existing EMA20 CAGR |
| --- | --- | --- | --- | --- | --- |
| BTC 2020-09 → now | 40% | 42% | 46% | 77% | 30% |
| ETH 2020-09 → now | 63% | 39% | 45% | 81% | 54% |
| SOL 2020-09 → now | 102% | 83% | 87% | 97% | 113% |

- BTC gains no extra return; the benefit is drawdown reduction. ETH shows a clear edge. SOL gains return but its drawdown stays very high.
- Every SMA length from 125 to 300 is positive, so the edge is general trend persistence, not the number 200.
- It trades about 61 sides a year with a ~6-day average hold and a 13% trade win rate. Costs take about 14 CAGR points a year; returns come from a few long trends.
- Hourly perp borrow wipes out the result, so it only works as spot.
- It agrees with the live daily EMA20 spot filter on ~90% of days. It is the same mechanism sampled differently and adds little new information.

### What exists (built, research-only)

| File | Purpose |
| --- | --- |
| `scripts/research/edge/fetch-4h-long.js` | Binance 4h + 1d history to `var/edge/4h-long/` (2017+, SOL 2020+), validation + sha256 manifest |
| `scripts/research/edge/sma4h-trend.js` | Pure `runSma4h()` + CLI: costs S1–S4, metrics, regimes, attribution, EMA20 overlap, sensitivity, `charts.html` |
| `test-sma4h-trend.js` (`npm run test:sma4h`) | 6 look-ahead / correctness checks |
| `var/research/external-4h-sma200/` (gitignored) | summary.json, trades.jsonl, equity.csv, REPORT.md, charts.html |

Regenerate the data and results:

```bash
node scripts/research/edge/fetch-4h-long.js
node scripts/research/edge/sma4h-trend.js
npm run test:sma4h
```

### Bucket of work (all PARKED unless marked)

| # | Item | Size | Status | Depends on / notes |
| --- | --- | --- | --- | --- |
| 1.1 | Review the study doc and charts; decide whether a spot trend arm is wanted at all | S | PARKED | You. Key question: do we want a second trend filter when EMA20 already runs? |
| 1.2 | Merge branch `edge-external-4h-sma200` (research files only) into main | S | PARKED | After 1.1. No production files touched. |
| 1.3 | Paper arm: add `EXTERNAL_4H_SMA200_V1` beside EMA20 in the spot tracker (`scripts/tracker/spot-trend.js`, `spot-page.js`). 60-day run. | M | BLOCKED | Engine freeze until 2026-10-08. Another session has uncommitted tracker edits. Pass criterion: live paper signals match a replay of the same closed bars exactly; compare with EMA20 on identical dates. |
| 1.4 | Decide the role in EditTrades: independent spot strategy, higher-timeframe regime filter for the perps engine, or a confidence input | S | PARKED | Needs 1.3 data. The low-information overlap with EMA20 argues for a regime or confidence role, not a new strategy. |
| 1.5 | Rigor upgrades: seeded random-entry controls, walk-forward folds, block-bootstrap CIs | L | BLOCKED | The edge-v1 harness (`EDGE_HARNESS_SPEC`) is not built yet. Only needed if 1.3 looks promising. |
| 1.6 | Whipsaw reduction study (longer N, or a confirmation band) | M | PARKED | New preregistered hypothesis; do not tune the V1 rule. Sensitivity hints that N=250–300 whipsaws less on BTC. |
| 1.7 | Portfolio view: BTC/ETH/SOL combined, with the 40% vol target used by EMA20 | M | PARKED | Reuse the `spot-portfolio.js` pattern. |
| — | Perps adaptation | — | DROPPED | Borrow cost destroys the edge at any tested rate. |
| — | 1H MA-slope / 5M MACD entry timing (first master prompt) | — | DROPPED | Its source repo (`iolufemi/crypto-trend-research`) could not be found, so no exact definitions exist. |

### Caveats to remember

- Data is Binance spot klines. Binance's main API is geo-blocked from this machine (HTTP 451); the fetcher uses the `data-api.binance.vision` fallback.
- The perp borrow rates are static scenarios, not history.
- No 1m execution paths; costs are not calibrated to real fills.
- The reference backtester fills at the same-bar close (optimistic); we use the next open.

---

## Card 2 — Quattro (4H Donchian breakout + daily EMA200 regime)

- **Source:** `EstebanSP23/crypto_systematic_research` @ `5df0c43`, `2_strategies/01_quattro_donchian/`
- **Status:** PARKED. This is the next external candidate after Card 1 review; nothing is built.

What we know from reading the source (not run):
- Entry: the closed 4H close breaks the prior 20-bar high while close > daily EMA200 (shifted a day), filled at the next bar's open.
- Management: ATR(14) is fixed at entry. It pyramids up to 4 units at +0.5/1.0/1.5 N, with a trailing stop at newest entry − 2N, 2% risk per unit and a 20x leverage cap.
- Discrepancy: the README says the daily EMA200 must be rising, but the code only checks close > EMA200. Test the code's rule.
- It is BTC-only, 2022–2026. The reported +610% after costs depends heavily on leverage.

| # | Item | Size | Status | Notes |
| --- | --- | --- | --- | --- |
| 2.1 | Register and build Quattro as a single unit without leverage in the `sma4h-trend.js` style, same costs and windows | M | PARKED | Question: does waiting for a breakout cut the 13%-win whipsaw from Card 1? |
| 2.2 | Add the source's pyramid / ATR management as a separate arm | M | PARKED | Only if 2.1 has a gross edge. |

---

## Open questions for the owner (answer when ready)

1. Is the goal spot trend exposure (EMA20-style), perps trade frequency, or both? Card 1 only helps spot.
2. Is a second spot trend arm worth tracker space if it agrees with EMA20 on 90% of days?
3. After Card 1, should Quattro run next, or should the new strategy you're handing to another agent get priority?

---

## Template for the next card

```
## Card N — <STRATEGY_ID>
- Study doc / branch / date / verdict
### What it is
### What we learned (table + 3–5 bullets)
### What exists (files)
### Bucket of work (# | item | size | status | depends on)
### Caveats
```
