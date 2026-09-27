# Edge evidence summary — master-plan build WP1–WP11 (2026-09-27)

Plan: [MASTER_PLAN_EDGE_HARNESS_2026-09-27.md](./MASTER_PLAN_EDGE_HARNESS_2026-09-27.md). Per-WP reports: [harness/](./harness/).

Branch `edge-external-4h-sma200`, research code only. There were no engine, tracker, deploy or live changes. Tests: `npm run test:research` (22 files, 0 failures) and the deploy gate (`test:sltp` 50, `test:scalp` 122, `test:mcp`, `test:wallet` 28) all pass.

The orchestrator independently spot-checked every headline marked ✔.

## 1. The biggest finding: costs were overstated

- **Jupiter long borrow is ≈ 0.0013–0.0015%/h, not 0.02–0.024%/h** (WP6). ✔ Confirmed three ways: decoded custody state, Jupiter's API `perps-api.jup.ag/v1/pool-info`, and realized on-chain accrual. Utilization is ≈ 10%; the curve gives ≈ 0.004%/h at 80%. Short-side borrow is ≈ 0.0006%/h.
- Consequence ([BREAKEVEN_COSTS](./BREAKEVEN_COSTS_2026-09-27.md) addendum ✔): strategies surviving costs with n ≥ 30 go from **2 to 16** (14 at the 0.004%/h stress). Hyperliquid real funding over the same trade window gives the same picture: 14/16 revived (WP5). **Slow perps strategies are live candidates again.** Fees still kill every fast strategy.
- The app's own borrow estimate is stale: `services/jupiterPerps.js` `getPerpQuote()` reads `hourlyFundingDbps`, which is 0 on every custody. Post-freeze fix.

## 2. Is the evidence real?

| Check | Result |
| --- | --- |
| Look-ahead (WP1) | All 17 swing rules, `runSma4h` (~5.2M comparisons), and edge families F1–F4 **pass**. Timestamp chain: 0 violations in 736 trades. Advisory: `legacy-trend4h.js` `mtfEntry` (mirrors production TREND_4H) has no internal `ctx.i` bound; safe today only because the caller never over-supplies. |
| Live vs research indicators (WP2) | Live fetches 500 bars on every timeframe (`services/scalpContext.js:112`) ✔. EMA21/RSI/Stoch RSI/ATR are identical. EMA200 differs by 0.01–0.26% (median) and flips close-vs-EMA200 at ≤ 1.7% of points. Optional post-freeze change: 1000 bars. |
| Independent implementation (WP11) | Freqtrade reproduces SMA200: BTC 43.3% vs 42.0% CAGR, ETH 71.3% vs 70.8%, **~98% of entry timestamps identical**. |
| Same-bar stop/TP ambiguity (WP11) | 0 ambiguous signals in 7,475, so net-R results are exact, not bracketed. |
| Quattro reproduction (WP8) | Our engine matches **400/400** of the source's committed trades. Quattro is multi-asset in code (not BTC-only). |
| Cross-venue data (WP5) | OKX vs Binance median close difference ≈ 1 bp. SMA200 is robust on all three coins; SMA840 on SOL is vendor-sensitive (91% vs 122% CAGR). |
| Multiple testing (WP3) | 118 trials in the ledger. The deflated Sharpe is ≈ 0 for the SMA arms (approximate: frequency-mismatched inputs). **Treat every single result as provisional.** |

## 3. Candidate verdicts

| Candidate | Evidence | Verdict |
| --- | --- | --- |
| **`re-flag-retest-1h`** (engine-family 1h flag retest, perps) | n=99 on deep2y (~2 years, not 85 days). Matched-random controls p ≈ 0.01–0.05; MAE 0.78R vs 0.93R for controls; exact break-even 3.3–3.5× at measured borrow (1.82× at the old rate). **But:** the day-block CI crosses 0 (54 distinct days); losses are serially clustered (longest streak 19 and maxDD 16.8%, both beyond the 95th percentile of shuffles); BTC significant, SOL moderate, ETH not. | **PAPER CANDIDATE**, the lead perps candidate. Track per symbol, size small. |
| **SLOW_SMA840_4H_V1** (≈ 20-week, spot) | Beats plain weekly DCA on every symbol and window ✔ (BTC 2024+: $17,484 vs $15,996 on $14,300 contributed). Widest cost headroom (12–20× break-even). SOL is vendor-sensitive. | **PAPER CANDIDATE**, the lead spot candidate. |
| SMA200 4h (spot) | Real next-bar signal (Jesse test p ≈ 0.01–0.09); Freqtrade-confirmed; no cost headroom versus B&H on BTC | PAPER CANDIDATE for ETH/SOL; INCONCLUSIVE for BTC |
| Vol-target 40% + 0.10 buffer overlay | Cuts maxDD 30–50%; Sharpe better in only about half the rows | PAPER CANDIDATE as a **risk** tool only |
| Equal-weight BTC/ETH/SOL filtered portfolio | Loses to B&H on CAGR; the vol-overlay version has the best Sharpe (1.19) | REJECT on return, keep for risk |
| Quattro (4h Donchian + EMA200 regime, no leverage) | Viable on perps at measured borrow (6.5–22× margin) but loses to SMA200/840 net CAGR in 12/12 cells; lower exposure (~20%) and DD (19–28%) | PAPER CANDIDATE, low priority |
| Slow edge-search families (4h Donchian, squeeze, daily RSI(2)) | Revived by real borrow; train-phase only | INCONCLUSIVE until a holdout |
| DONCHIAN_4W_V1 | Loses to DCA on BTC | REJECT |
| Daily EMA20 (live spot tracker arm) | Beats lump-sum B&H but **loses to plain weekly DCA on BTC since 2020** | Flag for owner review |
| MACD cross (perps + spot) | Perps −0.19R/−0.27R; spot 7–20% CAGR vs SMA200 42–102% ✔ | REJECT; don't add to the engine |
| OBV confirmation of breakouts | Confirmed trades beat unconfirmed in 6/8 configs; none survive | INCONCLUSIVE |

## 4. What the live engine's own record says (WP10, tracker data 2026-09-23 → 27; thin)

- WAIT calls: in ≈ 42% of rows, price reached +1R before −1R within 4h, so **many missed moves**. Actionable-call TP1 rates were 28–33% (n=6–7).
- The `qual.quality` “high” band underperforms “med” (hit 43.8% vs 46.5%, mean R −0.18 vs −0.04): **confidence labels are not calibrated**.
- 5 of 6 actionable GOOD calls were **short during a bull regime**, even though reject-path gates are trend-aware.
- 1m flag plans with 0.02–0.49% stops turn TP1 “wins” into net losses (−0.97R, −4.42R), confirming the cost floor matters.
- Drift monitor built; it reports INSUFFICIENT (n < 30), as it should.

## 5. Where an edge can survive costs (current best reading)

1. **Slow trend on spot**: SMA840 ≈ 20-week, with an optional vol overlay for drawdown. This is the most robust result found: it beats DCA, has wide cost headroom, and is independently reproduced (SMA family).
2. **The 1h flag retest on Jupiter perps** (`re-flag-retest-1h`): the one engine-native setup that beats matched chance after real costs. It needs forward paper evidence and per-symbol handling.
3. **Slow perps trend/breakout families** are no longer cost-killed. They need a proper holdout before any claim.
4. **Engine signal quality issues** (uncalibrated confidence, short skew in a bull regime, missed WAIT moves) are measurable now. They are fixes to investigate post-freeze, not edges.

## 6. Next bounded actions (owner decisions)

1. Paper-track SLOW_SMA840_4H_V1 (and the vol overlay) beside the EMA20 spot arm after the freeze (Card 1.3 path).
2. Paper-track `re-flag-retest-1h` per symbol with a fixed small size and a frozen baseline for the drift monitor.
3. Holdout run (2026 data) for the revived slow edge-search configs: maximum 2 finalists, pre-registered.
4. Post-freeze engine fixes to consider:
   - borrow-field staleness in `services/jupiterPerps.js`;
   - `ctx.i` bound on the TREND_4H path;
   - FETCH_LIMIT 1000 (optional);
   - investigate the short skew and the confidence banding.
5. Re-review whether daily EMA20 should remain the spot arm, given that it loses to DCA on BTC.
