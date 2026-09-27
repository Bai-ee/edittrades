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

## Card 3 — Harness upgrades borrowed from external frameworks

- **Doc (full review, corrections, evidence):** [EXTERNAL_HARNESS_REFERENCES.md](./EXTERNAL_HARNESS_REFERENCES.md)
- **Date:** 2026-09-27
- **Verdict:** borrow 8 concepts, adopt no platforms. Every item needs re-verification before a build.

| # | Item | Size | Status | Source concept |
| --- | --- | --- | --- | --- |
| 3.1 (R1) | Generic causality auditor over all rule modules | S | PARKED | Freqtrade `lookahead-analysis` |
| 3.2 (R2) | Indicator warm-up audit (live `limit=500` vs research history) | S | PARKED | Freqtrade `recursive-analysis` |
| 3.3 (R3) | Rule significance test (block bootstrap of signal × detrended return) | S–M | PARKED | Jesse rule significance |
| 3.4 (R4) | Trade-order shuffle Monte Carlo in `risk-sim.js` | S | PARKED | Jesse MC trades |
| 3.5 (R5) | Cross-venue OHLCV + funding reference (Bybit/OKX) | M | PARKED | CCXT (npm dep needs approval, or direct REST) |
| 3.6 (R6) | Freqtrade second-implementation check for finalists (SMA200) | M | PARKED | Freqtrade (external tool only, GPL) |
| 3.7 (R7) | Candle block-bootstrap Monte Carlo | M | PARKED after 3.3 | Jesse MC candles |
| 3.8 (R8) | Adaptive same-bar ordering as a second bound | S | PARKED | Nautilus concept |
| 3.9 (R10) | Drift check on the forward ledger | S | verify first | — |
| 3.10 (R3b) | Matched-random entry controls (timing/regime-matched, net of borrow) | M | PARKED after 3.3 | Owner handoff §10 |
| 3.11 (R11) | WAIT / no-trade outcome scoring (missed trades) | S–M | PARKED | Owner handoff §9.5 |
| 3.12 (R12) | Fixed-horizon MFE/MAE backfill for every capture + completeness states | S–M | PARKED | Owner handoff §9 |
| 3.13 (R13) | Code SHA on capture rows | S | PARKED | Owner handoff §8.5 |
| 3.14 (R14) | Reason-code incremental attribution, net of costs | M | PARKED after 3.12 | Owner handoff §8.4 |
| 3.15 (R15) | Calibration of headline recommendation confidence | S | PARKED after 3.12 | Owner handoff §8.3 |
| — | Adopt Jesse / Nautilus / Hummingbot / FinRL / Eliza as platforms | — | DROPPED | No Jupiter support, rebuild cost, or off-goal |

Reconciled with the owner's orchestrator handoff doc (2026-09-27), copied to `external-refs/`. `EXTERNAL_HARNESS_REFERENCES.md` is the source of truth; its **Revised rollout order** (H1–H5) supersedes both earlier orders. Every phase must report net R under actual Jupiter costs including borrow (Card 6).

Key corrections to the proposal:
- Jesse's significance test is a bootstrap of the rule's own returns, not random entries.
- Jesse fills at the same-bar close.
- Neither CCXT nor Nautilus supports Jupiter.

---

## Card 4 — Lessons from the “70 bot strategies” write-up (external, 2026-09-27)

- **Source:** an anonymous builder's article, “I Tested 70 Trading Bot Strategies So You Don't Have To…”, pasted by the owner. BTC/ETH on Binance 2020–mid-2026, Hyperliquid BTC perps bot, 4h pullback + scoring.
- **Credibility:** methodologically sound. Rules were written down before testing, fills at the next price, real fees, slippage and funding, and a 2020–23 train / 2024–26 test split. The author states negative results and caveats. There is no raw data or code, so treat the numbers as anecdote and the method as sound.
- **Verdict:** it mostly **confirms** existing EditTrades findings:
  - Fast trading loses to fees (`EDGE_SEARCH_2026-09-27.md`).
  - Sizing is what controls drawdown (`RISK_SIZING_STUDY_2026-09-26.md`).
  - Slow trend rules have no edge after 2024 on BTC but survive as drawdown control (Card 1).
  - Market making loses to adverse selection (Card 3 dropped Hummingbot).
  Four new actionable items below.

### Exploratory check on our data (NOT registered; counts as trials)

Train/test split and a 20-week SMA (N=840 on 4h, ≈ the article's “20-week average” rule), S3 costs, `runSma4h`:

| | 2020–23 CAGR / DD | 2024–26 CAGR / DD | B&H 2024–26 CAGR / DD | Entries 20–23 / 24–26 |
| --- | --- | --- | --- | --- |
| BTC SMA200 | 61% / 46% | 23% / 35% | 29% / 53% | 130 / 83 |
| BTC 20-wk | 76% / 41% | 31% / 26% | 29% / 53% | 22 / 31 |
| ETH SMA200 | 126% / 43% | 31% / 45% | 6% / 68% | 100 / 81 |
| ETH 20-wk | 82% / 63% | 34% / 41% | 6% / 68% | 43 / 19 |
| SOL SMA200 | 227% / 87% | 14% / 57% | 7% / 78% | 121 / 96 |
| SOL 20-wk | 327% / 71% | 8% / 61% | 7% / 78% | 35 / 45 |

Read:
- On BTC, SMA200 lags B&H in the test years; only the drawdown benefit remains.
- The slower 20-week rule held on BTC in both halves with far fewer trades, but was worse on ETH in 2020–23.
- This matches the article: slow trend is a drawdown tool, not a return edge on BTC.
- Caveat: N=840 warm-up delays the start of the first window, and SOL starts in 2020-08.

### Bucket of work

| # | Item | Size | Status | Why / notes |
| --- | --- | --- | --- | --- |
| 4.1 | **DCA benchmark** for spot filters: plain weekly DCA vs DCA into the filter (cash builds while the filter is flat, deployed when long). Apply to EMA20 (tracker arm) and SMA200. | S | PARKED | The article's strongest finding: nothing beat weekly DCA. Our spot comparisons use lump-sum B&H only, which is the wrong baseline for a contribution-funded spot arm. |
| 4.2 | **Global trial ledger + multiple-testing discount** (deflated Sharpe or White's Reality Check) across all EditTrades studies: 76 edge-search configs, 15 variants, swing rules, Card 1 sweeps and the Card 4 exploratory runs | S–M | PARKED | “Test 70 things and one looks great by luck.” The harness spec §1/§6 already requires it; nothing implements it. Pairs with Card 3 R3. |
| 4.3 | **Side-mix / filter-blocking audit** of the live engine: long/short share of served calls vs market regime; which gates block which side and how often | S | PARKED | The author's bot was 86% shorts in a bull market because a funding filter blocked longs. Our guardrail plan lists “shorts negative on every variant” as undecided. |
| 4.4 | **Slow-trend registered variant**: 20-week SMA (N=840) and a 4-week Donchian, frozen, both windows | S | PARKED → merge into Card 1 item 1.6 | The exploratory table above justifies registering it; do not adopt from the exploratory run. |
| — | Funding look-ahead check | — | N/A | The engine uses funding only in execution (`positionManager.js`, `jupiterPerps.js`), not in signals. Guardrail for the future: any funding feature must use settlement-time availability. |
| — | Risk cut from 6% to 1% | — | DONE already | `RISK_SIZING_STUDY_2026-09-26.md` (0.5%/trade keeps p95 DD ~15%) and guardrails G1. |
| — | Power-law / MVRV / Fear & Greed DCA sizing | — | DROPPED | Within ±1% of DCA in the article; DCA sizing is not the EditTrades product. |
| — | AI market making | — | DROPPED | The article's simulation lost before fees to adverse selection; consistent with Card 3. |

---

## Card 5 — Indicator additions: MACD and OBV

- **Requested by:** owner, 2026-09-27 (“good indicators, document for install”).
- **Current state:**
  - Neither exists in the engine (`services/`, `lib/`).
  - VWAP exists (`lib/advancedIndicators.js:14`); RSI, Stoch RSI, EMA and ATR exist.
  - A volume-context engine change is **parked** (commit `2330db1`, schema 1.26, not merged, owner deferred 2026-09-26). OBV belongs with it.
- **Honest prior:**
  - MACD is EMA(12) − EMA(26); it largely overlaps the momentum families already tested (none net-positive).
  - OBV adds genuinely new input (volume), which the engine currently barely uses.
  - Neither should affect live signals without evidence.

| # | Item | Size | Status | Notes |
| --- | --- | --- | --- | --- |
| 5.1 | Add `macd(close, 12, 26, 9)` and `obv(bars)` to research `scripts/research/edge/lib.js`, with tests (hand-computed fixture, append-future invariance) | S | PARKED | Research only; no engine change. |
| 5.2 | Evidence test: (a) MACD cross as an entry signal; (b) OBV-confirmed vs unconfirmed breakouts, on existing swing and breakout replays. Score with Card 3 R3 significance plus net R after costs. | M | PARKED, after 3.3 | Register before running. OBV question: does “price up + OBV up” separate winners from losers? |
| 5.3 | Engine / MCP exposure: add as **context fields only** (no gate), bundled with the parked volume-context P1 | S–M | BLOCKED | Engine freeze until 2026-10-08; needs 5.2 evidence; schema bump + openapi + CHANGELOG per the repo phase rules. |

---

## Card 6 — Break-even cost table (every studied strategy)

- **Doc:** [BREAKEVEN_COSTS_2026-09-27.md](./BREAKEVEN_COSTS_2026-09-27.md). Script: `scripts/research/edge/breakeven.js`.
- **Date:** 2026-09-27. **Status:** DONE (analysis); follow-ups PARKED.
- **Result (79 perps / trade-level strategies):**
  - 24 have no gross edge, 26 are killed by fees, **21 are killed by borrow**.
  - 2 survive with n ≥ 30: `re-flag-retest-1h` (n=99, 2.2× cost margin) and `R2b-rsi2pb-1d-k3` (n=35, weak t).
  - Spot trend rules all survive costs, but only the 20-week rule beats B&H with wide cost headroom; BTC SMA200 has none.
- **Main insight:** on Jupiter perps the hourly borrow (≈ 0.024%/h), not fees, kills every slower edge (4h Donchian incl. Quattro's entry, squeeze, daily momentum; tolerable 0.003–0.011%/h). Fast edges die to fees. Venue cost structure matters more than signal choice.

| # | Item | Size | Status | Notes |
| --- | --- | --- | --- | --- |
| 6.1 | **Measure real Jupiter borrow history** (utilization-based; custody cumulative interest) and rerun the table with it | S–M | PARKED | The whole “borrow kills” group hinges on 0.02–0.024%/h. Read-only on-chain/API; no wallet. |
| 6.2 | **Low-carry venue check:** rerun the “borrow kills” group using real CEX/Hyperliquid funding history (Card 3 R5) instead of static borrow | M | PARKED, after 3.5 | If carry is under ~0.005%/h, the 4h Donchian/Quattro family may survive. A venue change is a separate owner decision. |
| 6.3 | **Promote `re-flag-retest-1h` to the next evidence step:** Card 3 R3 significance, per-trade break-even (not aggregate), and a longer fixture | S–M | PARKED | The only short-hold perps setup with cost margin. No variants. |
| 6.4 | Re-point Quattro (Card 2) to **spot or low-carry venue only**; don't build it for Jupiter perps | — | DECIDED (pending owner review) | Its core entry (F1-don-4h-N20) has break-even borrow ≈ 0.005%/h. |
| 6.5 | Add a break-even column to every future study report (harness spec §7 already asks for it) | S | PARKED | Reuse `breakeven.js` `perTrade()`. |

---

## Reviewed and dropped (don't re-review without new evidence)

| Date | Source | Claim | Why dropped |
| --- | --- | --- | --- |
| 2026-09-27 | X post, @0x_Punisher, “7 indicators” Polymarket bot thread (marked “Paid partnership”, Telegram funnel) | RSI + MACD + Stoch + EMA + OBV + VWAP + ATR filter stack gives bot edge on 5-min BTC Up/Down markets | No rules, no verifiable P&L, survivorship framing. The venue is binary contracts, not Jupiter perps. Already tested and failed after costs: RSI-extreme reversion (`MEANREV_STUDY_2026-09-26.md`, −0.52R), vol-squeeze, RSI(2) and Bollinger families (`EDGE_SEARCH_2026-09-27.md`, 0 of 76 net-positive). EMA, Stoch RSI, VWAP and ATR already exist. OBV is covered by the in-flight volume-context work. MACD is redundant with the tested momentum families. |

---

## Open questions for the owner (answer when ready)

1. Is the goal spot trend exposure (EMA20-style), perps trade frequency, or both? Card 1 only helps spot.
2. Is a second spot trend arm worth tracker space if it agrees with EMA20 on 90% of days?
3. After Card 1, should Quattro run next, or should the new strategy you're handing to another agent get priority?
4. Card 3: approve the `ccxt` npm dependency, or use direct Bybit/OKX REST calls (3.5)?
5. Card 3: build H1 (3.1 + 3.2) before any more strategy studies? It checks every study we already have.
6. Card 4.1: should the spot arm be judged against weekly DCA, as the natural baseline for contribution-funded holding?
7. Card 5: MACD/OBV as display context only, or candidates for gates if 5.2 shows evidence?
8. Card 6: is a perps venue other than Jupiter (lower carry) on the table if 6.1/6.2 confirm borrow is the blocker? Or should slow strategies live on spot only?

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
