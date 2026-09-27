# Break-even cost table — every studied strategy vs what EditTrades pays (2026-09-27)

> **ADDENDUM 2026-09-27 (later the same day) — the borrow assumption below was wrong. See [harness/WP6_JUPITER_BORROW.md](./harness/WP6_JUPITER_BORROW.md).**
>
> The real Jupiter long borrow was measured at **≈0.0013%/h (BTC, ETH) and 0.0015%/h (SOL)** at about 10–12% pool utilization. Two independent sources agree:
> - decoded custody `jumpRateState` + utilization;
> - Jupiter's own API, `perps-api.jup.ag/v1/pool-info` → `longBorrowRatePercent`.
>
> That is 13–18× below the 0.02–0.024%/h used in this document, which came from older Jupiter docs written when utilization was high. The curve gives ≈0.003–0.004%/h at its 80% utilization target and at most ≈0.01–0.017%/h at 100%.
>
> Re-run (`node scripts/research/edge/breakeven.js --main ../snapshot_tradingview --borrow <rate>`):
>
> | Verdict (79 strategies) | 0.02%/h (old) | **0.0015%/h (measured)** | 0.004%/h (80%-util stress) |
> | --- | --- | --- | --- |
> | Survives, n ≥ 30 | 2 | **16** | 14 |
> | Survives, n < 30 | 6 | 11 | 9 |
> | Borrow kills | 21 | 2 | 6 |
> | Fees kill | 26 | 26 | 26 |
> | No gross edge | 24 | 24 | 24 |
>
> At the measured rate, the 4h Donchian breakouts (incl. Quattro's F1-don-4h-N20 entry), the 4h squeeze, the daily RSI(2) pullback and `re-flag-retest-1h` all clear costs with a 1.7–11× margin. **The earlier finding that “borrow, not fees, kills slow perps edges” is withdrawn.** Fees still kill the fast strategies.
>
> Caveats:
> - These are train-phase, in-sample configs from a 52-config search. The original edge search found none with t ≥ 1, so they still need holdout + significance (WP3/WP4) before any claim of edge.
> - Borrow is utilization-driven, so re-check it before any live use.
> - Side finding (not fixed, engine freeze): `services/jupiterPerps.js` `getPerpQuote()` reads the legacy `hourlyFundingDbps` field, which is **0 on every custody**, so the app's own borrow estimate is stale.


Research only. Question: for each strategy already studied, how much round-trip cost could it absorb before its net result hits zero, and how does that compare with what EditTrades pays?

**Script:** `scripts/research/edge/breakeven.js`.
**Command:** `node scripts/research/edge/breakeven.js --main ../snapshot_tradingview`.
**Output:** `var/research/breakeven/{REPORT.md,rows.json}`.

Inputs, all pre-existing results reused, with no new strategies and no retuning:
- Edge-search Round 1 (38 configs, regenerated here from `run.js --phase train`, deep2y fixture) and Round 2 (14 configs, main checkout `var/edge/train.json`). Train phase only, before 2026-01-01.
- Engine replay variants V0–V7, V-B, V-D (main checkout `var/replay-rules/*.calls.jsonl`, 15 days, small n).
- Swing and mean-reversion study aggregates (`docs/swing/*.json`, 85 days). These are approximate: they use grossExpR × median stop.
- Spot long/flat trend rules on `var/edge/4h-long` and `var/edge/daily-long` (2017+, SOL 2020+).

Cost reference:
- Perps: 0.20% long / 0.14% short round trip.
- Jupiter borrow: ≈ 0.024%/h per Jupiter docs (`REVIEW_PACKET_2026-09-24.md:179`); 0.02%/h is used as the base.
- Spot: 0.15% per side.

## Headline

| Verdict (79 perps / trade-level strategies) | Count |
| --- | --- |
| No gross edge (negative before any cost) | 24 |
| Fees kill (gross edge < round-trip fees) | 26 |
| **Borrow kills** (beats fees, negative once hourly borrow is charged) | **21** |
| Survives, n ≥ 30 | 2 (`re-flag-retest-1h` n=99; `R2b-rsi2pb-1d-k3` n=35, t≈0.5 in the original study) |
| Survives, n < 30 | 6 (engine replay variants on 15 days; `ctl-donchian-20d` n=7): too few to judge |

Findings:
1. **On perps, borrow is the binding constraint for every slower strategy, not fees.**
   - All 4h Donchian breakouts (F1-4h, including the N20 entry that is Quattro's core), the 4h squeeze and daily time-series momentum have a gross edge above round-trip fees.
   - But they tolerate only **0.003–0.011%/h** of borrow, against Jupiter's ≈ 0.024%/h.
   - Holding a Jupiter perp for days costs ~0.5%/day, which no slow edge here covers.
2. **Fast strategies lose to fees.** Their gross edge per trade is a few bps against a 0.17–0.20% round trip (26 rows).
3. **The only perps survivor with a usable sample is `re-flag-retest-1h`:**
   - 1h flag retest with a 1D/4h trend gate (S3 study).
   - n=99, gross +0.44R, net +0.27R, positive in both OOS halves.
   - Break-even round trip ≈ 0.43% with borrow, **2.2× actual**; tolerates up to ≈ 0.045%/h borrow.
   - The numbers are approximate (aggregate-based), from 85 days of data.
4. **Spot has no borrow and every trend rule survives costs.** But only the slow rule clears the “beat buy-and-hold” cost bar by a wide margin:

| symbol | rule | gross CAGR | net @0.15% | B&H | break-even/side (net=0) | break-even/side (beat B&H) |
| --- | --- | --- | --- | --- | --- | --- |
| BTC | 4h SMA200 (Card 1) | 56% | 42% | 40% | 0.72% | **0.17%** (≈ actual 0.15%, no margin) |
| BTC | 4h SMA840 ≈ 20-week (Card 4) | 47% | 44% | 22%* | 2.58% | 1.27% |
| BTC | daily EMA20 (live spot tracker) | 51% | 42% | 38% | 1.01% | 0.22% |
| ETH | 4h SMA200 | 85% | 71% | 28% | 1.14% | 0.69% |
| ETH | 4h SMA840 | 43% | 39% | 13%* | 2.01% | 1.33% |
| ETH | daily EMA20 | 66% | 56% | 26% | 1.22% | 0.67% |
| SOL | 4h SMA200 | 125% | 102% | 83% | 1.13% | 0.29% |
| SOL | 4h SMA840 | 131% | 121% | 116%* | 2.98% | 0.24% |
| SOL | daily EMA20 | 113% | 99% | 71% | 1.68% | 0.49% |

\* SMA840's longer warm-up starts its window later, so its B&H figure is not the same period as the other rows. Compare the break-even columns, not the B&H column.

## What this means

- **Venue cost structure decides the edge more than signal choice does.** The same Donchian/trend signals that fail on Jupiter perps pass on spot. They might pass on a perp venue whose carry cost is under ~0.005–0.01%/h. A typical CEX baseline funding of 0.01% per 8h is ≈ 0.00125%/h, but funding swings and longs pay more in bull markets, so this needs real funding history, not the baseline.
- **Quattro (Card 2) on Jupiter perps is dead on arrival** unless the actual borrow is far below 0.024%/h. Its natural home is spot, or a low-carry venue.
- **The perps engine's best lead is the 1h flag retest (`re-flag-retest-1h`)**, the one short-hold setup whose gross edge clears both fees and borrow with margin. It is already an S3 study; it needs the Card 3 R3 significance test and more data, not more variants.
- **BTC SMA200 has no cost headroom versus buy-and-hold.** A slower rule (20-week) has 8× headroom on BTC and ETH.

## Caveats

- Replay variants (V*) cover 15 days with n=4–172; swing rows are 85 days and aggregate-approximate. Only edge-search and spot rows are multi-year and per-trade exact.
- The borrow rate is static. Jupiter borrow is utilization-based and varies; the real historical rate was not measured.
- Edge-search rows are the train phase only. Survivors were not re-checked on the holdout.
- These are prior-inspected strategies, so this is a ranking of existing results, not new evidence. Multiple-testing discount applies (Card 4.2).

## Full table (generated)

## Perps / trade-level strategies — break-even round trip vs actual

Break-even = all-in round-trip fees + slippage (% of notional) at which mean net R = 0. “with borrow” also charges 0.02%/h on each trade's actual hold. Actual = 0.2% long / 0.14% short round trip, weighted by the strategy's side mix. Margin = break-even with borrow ÷ actual; > 1 survives. Max borrow = hourly borrow at which net R = 0 given actual fees (Jupiter docs ≈ 0.024%/h). “≈” rows use aggregate grossExpR × median stop (approximate). Verdict: *no gross edge* = negative before any cost; *borrow kills* = positive with fees only, negative once borrow is charged.

| rank | strategy | source | n | gross R/trade | median stop | break-even (no borrow) | break-even (with borrow) | actual | margin | max borrow %/h | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ctl-donchian-20d | swing study (85d, aggregate) ≈ | 7 | 0.182 | 18.98% | 3.456% | 2.016% | 0.20% | 10.08× | 0.0452 | survives (n<30) |
| 2 | V-B | engine replay variant (15d) | 13 | 1.972 | 0.42% | 0.884% | 0.612% | 0.19% | 3.29× | 0.0513 | survives (n<30) |
| 3 | R2b-rsi2pb-1d-k3 | edge-search (2y, train) | 35 | 0.145 | 16.77% | 2.106% | 0.571% | 0.18% | 3.18× | 0.0251 | survives |
| 4 | V0 | engine replay variant (15d) | 11 | 1.797 | 0.40% | 0.724% | 0.501% | 0.18% | 2.73× | 0.0484 | survives (n<30) |
| 5 | V1c | engine replay variant (15d) | 11 | 1.797 | 0.40% | 0.724% | 0.501% | 0.18% | 2.73× | 0.0484 | survives (n<30) |
| 6 | V-D | engine replay variant (15d) | 11 | 1.797 | 0.40% | 0.724% | 0.501% | 0.18% | 2.73× | 0.0483 | survives (n<30) |
| 7 | re-flag-retest-1h | swing study (85d, aggregate) ≈ | 99 | 0.444 | 1.41% | 0.625% | 0.435% | 0.20% | 2.18× | 0.0448 | survives |
| 8 | V1b | engine replay variant (15d) | 23 | 0.990 | 0.35% | 0.317% | 0.196% | 0.18% | 1.09× | 0.0228 | survives (n<30) |
| 9 | mr-zone-touch-1h | swing study (85d, aggregate) ≈ | 108 | 0.410 | 0.39% | 0.160% | 0.134% | 0.20% | 0.67× | 0 | fees kill |
| 10 | V1a | engine replay variant (15d) | 40 | 0.566 | 0.26% | 0.113% | 0.063% | 0.18% | 0.35× | 0 | fees kill |
| 11 | R2c-shock-1h-follow-6h | edge-search (2y, train) | 305 | 0.134 | 1.22% | 0.143% | 0.059% | 0.17% | 0.35× | 0 | fees kill |
| 12 | R2b-rsi2pb-1d-k2 | edge-search (2y, train) | 35 | 0.145 | 11.18% | 1.404% | 0.048% | 0.18% | 0.27× | 0.0181 | borrow kills |
| 13 | V2 | engine replay variant (15d) | 15 | 1.323 | 0.58% | 0.606% | 0.029% | 0.19% | 0.15× | 0.0145 | borrow kills |
| 14 | F5-orb-us-3R-reg | edge-search (2y, train) | 593 | 0.034 | 1.24% | 0.033% | -0.040% | 0.17% | — | 0 | fees kill |
| 15 | re-flag-breakout-4h | swing study (85d, aggregate) ≈ | 38 | 0.231 | 3.23% | 0.745% | -0.052% | 0.20% | — | 0.0137 | borrow kills |
| 16 | F5-orb-us-2R-reg | edge-search (2y, train) | 593 | 0.018 | 1.24% | 0.017% | -0.049% | 0.17% | — | 0 | fees kill |
| 17 | V3b | engine replay variant (15d) | 14 | 1.198 | 0.67% | 0.541% | -0.055% | 0.19% | — | 0.0119 | borrow kills |
| 18 | F5-orb-us-trail-reg | edge-search (2y, train) | 593 | 0.012 | 1.24% | 0.012% | -0.057% | 0.17% | — | 0 | fees kill |
| 19 | mr-random-1h | swing study (85d, aggregate) ≈ | 5267 | 0.002 | 0.58% | 0.001% | -0.076% | 0.20% | — | 0 | fees kill |
| 20 | R2a-volbrk-k0.5-reg | edge-search (2y, train) | 401 | 0.065 | 2.49% | 0.126% | -0.069% | 0.17% | — | 0 | fees kill |
| 21 | V3a | engine replay variant (15d) | 27 | 0.695 | 0.36% | 0.238% | -0.078% | 0.18% | — | 0.0036 | borrow kills |
| 22 | R2a-volbrk-k0.3-reg | edge-search (2y, train) | 616 | 0.085 | 1.63% | 0.112% | -0.073% | 0.17% | — | 0 | fees kill |
| 23 | R2a-volbrk-k0.5 | edge-search (2y, train) | 841 | 0.066 | 2.43% | 0.127% | -0.079% | 0.17% | — | 0 | fees kill |
| 24 | V6 | engine replay variant (15d) | 172 | 0.210 | 0.43% | 0.096% | -0.086% | 0.18% | — | 0 | fees kill |
| 25 | F5-orb-us-3R | edge-search (2y, train) | 1329 | -0.009 | 1.35% | -0.009% | -0.085% | 0.17% | — | 0 | no gross edge |
| 26 | ctl-random-4h | swing study (85d, aggregate) ≈ | 724 | 0.129 | 0.83% | 0.107% | -0.105% | 0.20% | — | 0 | fees kill |
| 27 | F5-orb-us-2R | edge-search (2y, train) | 1329 | -0.021 | 1.35% | -0.022% | -0.091% | 0.17% | — | 0 | no gross edge |
| 28 | F5-orb-us-trail | edge-search (2y, train) | 1329 | -0.022 | 1.35% | -0.022% | -0.091% | 0.17% | — | 0 | no gross edge |
| 29 | F3-mr-1h-rsi2-k1.5-reg | edge-search (2y, train) | 1120 | 0.018 | 1.39% | 0.021% | -0.094% | 0.17% | — | 0 | fees kill |
| 30 | R2a-volbrk-k0.7 | edge-search (2y, train) | 601 | 0.040 | 3.07% | 0.098% | -0.102% | 0.17% | — | 0 | fees kill |
| 31 | R2a-volbrk-k0.3 | edge-search (2y, train) | 1152 | 0.075 | 1.67% | 0.099% | -0.108% | 0.17% | — | 0 | fees kill |
| 32 | F1-don-1h-N55-k2-reg | edge-search (2y, train) | 427 | 0.015 | 1.98% | 0.026% | -0.108% | 0.17% | — | 0 | fees kill |
| 33 | F4-squeeze-4h-k2-reg | edge-search (2y, train) | 60 | 0.157 | 3.73% | 0.496% | -0.109% | 0.17% | — | 0.0109 | borrow kills |
| 34 | F3-mr-1h-rsi2-k2.5-reg | edge-search (2y, train) | 944 | 0.017 | 2.31% | 0.033% | -0.118% | 0.17% | — | 0 | fees kill |
| 35 | F3-mr-1h-rsi2-k1.5 | edge-search (2y, train) | 2480 | -0.005 | 1.40% | -0.006% | -0.121% | 0.17% | — | 0 | no gross edge |
| 36 | R2c-shock-1h-follow-24h | edge-search (2y, train) | 288 | 0.106 | 1.21% | 0.112% | -0.125% | 0.17% | — | 0 | fees kill |
| 37 | F1-don-1h-N55-k2 | edge-search (2y, train) | 844 | 0.005 | 1.94% | 0.008% | -0.137% | 0.17% | — | 0 | fees kill |
| 38 | V4 | engine replay variant (15d) | 38 | 0.601 | 0.42% | 0.236% | -0.150% | 0.18% | — | 0.0028 | borrow kills |
| 39 | R2c-shock-1h-fade-6h | edge-search (2y, train) | 317 | -0.160 | 0.72% | -0.098% | -0.144% | 0.17% | — | 0 | no gross edge |
| 40 | F1-don-4h-N55-k2 | edge-search (2y, train) | 197 | 0.136 | 4.15% | 0.470% | -0.150% | 0.17% | — | 0.0096 | borrow kills |
| 41 | F3-mr-1h-bb-k1.5-reg | edge-search (2y, train) | 493 | -0.027 | 1.37% | -0.031% | -0.151% | 0.17% | — | 0 | no gross edge |
| 42 | R2a-volbrk-k0.7-reg | edge-search (2y, train) | 280 | 0.012 | 3.10% | 0.029% | -0.161% | 0.17% | — | 0 | fees kill |
| 43 | F1-don-1h-N20-k2 | edge-search (2y, train) | 1448 | 0.000 | 1.90% | 0.000% | -0.165% | 0.17% | — | 0 | fees kill |
| 44 | F3-mr-1h-rsi2-k2.5 | edge-search (2y, train) | 2043 | -0.005 | 2.30% | -0.010% | -0.166% | 0.17% | — | 0 | no gross edge |
| 45 | mr-rsi-extreme-1h | swing study (85d, aggregate) ≈ | 45 | -0.165 | 0.52% | -0.087% | -0.197% | 0.20% | — | 0 | no gross edge |
| 46 | F1-don-1h-N20-k2-reg | edge-search (2y, train) | 677 | -0.011 | 1.92% | -0.018% | -0.174% | 0.17% | — | 0 | no gross edge |
| 47 | F3-mr-1h-bb-k1.5 | edge-search (2y, train) | 1176 | -0.051 | 1.39% | -0.059% | -0.180% | 0.17% | — | 0 | no gross edge |
| 48 | F3-mr-1h-bb-k2.5-reg | edge-search (2y, train) | 432 | -0.006 | 2.30% | -0.012% | -0.183% | 0.17% | — | 0 | no gross edge |
| 49 | R2b-rsi2pb-1d-k3-long | edge-search (2y, train) | 23 | 0.104 | 16.49% | 1.381% | -0.252% | 0.20% | — | 0.0145 | borrow kills |
| 50 | R2c-shock-1h-fade-24h | edge-search (2y, train) | 312 | -0.170 | 0.72% | -0.104% | -0.217% | 0.17% | — | 0 | no gross edge |
| 51 | F3-mr-1h-bb-k2.5 | edge-search (2y, train) | 1025 | -0.026 | 2.30% | -0.050% | -0.219% | 0.17% | — | 0 | no gross edge |
| 52 | F1-don-4h-N55-k2-reg | edge-search (2y, train) | 139 | 0.104 | 4.23% | 0.367% | -0.254% | 0.17% | — | 0.0063 | borrow kills |
| 53 | pb-4h-flag-continuation | swing study (85d, aggregate) ≈ | 9 | -0.035 | 3.31% | -0.115% | -0.308% | 0.20% | — | 0 | no gross edge |
| 54 | F1-don-1h-N55-k3-reg | edge-search (2y, train) | 328 | 0.005 | 2.94% | 0.013% | -0.317% | 0.17% | — | 0 | fees kill |
| 55 | F1-don-1h-N55-k3 | edge-search (2y, train) | 642 | 0.008 | 2.88% | 0.019% | -0.323% | 0.17% | — | 0 | fees kill |
| 56 | ctl-4h-range-break | swing study (85d, aggregate) ≈ | 119 | 0.038 | 1.88% | 0.071% | -0.375% | 0.20% | — | 0 | fees kill |
| 57 | F1-don-4h-N20-k2 | edge-search (2y, train) | 359 | 0.095 | 4.11% | 0.333% | -0.323% | 0.17% | — | 0.0049 | borrow kills |
| 58 | F1-don-4h-N20-k2-reg | edge-search (2y, train) | 198 | 0.094 | 4.19% | 0.338% | -0.329% | 0.17% | — | 0.0050 | borrow kills |
| 59 | V5 | engine replay variant (15d) | 4 | -1.000 | 0.26% | -0.245% | -0.277% | 0.14% | — | 0 | no gross edge |
| 60 | F4-squeeze-4h-k3-reg | edge-search (2y, train) | 58 | 0.163 | 5.60% | 0.767% | -0.360% | 0.17% | — | 0.0107 | borrow kills |
| 61 | F1-don-1h-N20-k3 | edge-search (2y, train) | 1021 | 0.004 | 2.92% | 0.010% | -0.386% | 0.17% | — | 0 | fees kill |
| 62 | F1-don-1h-N20-k3-reg | edge-search (2y, train) | 510 | -0.032 | 2.93% | -0.079% | -0.434% | 0.17% | — | 0 | no gross edge |
| 63 | F4-squeeze-4h-k2 | edge-search (2y, train) | 133 | 0.044 | 3.55% | 0.133% | -0.462% | 0.17% | — | 0 | fees kill |
| 64 | pb-channel-edge-4h | swing study (85d, aggregate) ≈ | 77 | -0.021 | 3.26% | -0.067% | -0.547% | 0.20% | — | 0 | no gross edge |
| 65 | pb-ema21-pullback-1d | swing study (85d, aggregate) ≈ | 33 | -0.249 | 1.32% | -0.328% | -0.601% | 0.20% | — | 0 | no gross edge |
| 66 | F1-don-4h-N20-k3-reg | edge-search (2y, train) | 139 | 0.180 | 6.29% | 0.969% | -0.581% | 0.17% | — | 0.0103 | borrow kills |
| 67 | re-random-4h | swing study (85d, aggregate) ≈ | 90 | -0.048 | 3.18% | -0.154% | -0.795% | 0.20% | — | 0 | no gross edge |
| 68 | re-flag-retest-4h | swing study (85d, aggregate) ≈ | 48 | -0.069 | 3.32% | -0.227% | -0.858% | 0.20% | — | 0 | no gross edge |
| 69 | F1-don-4h-N55-k3 | edge-search (2y, train) | 149 | 0.109 | 6.23% | 0.568% | -0.768% | 0.17% | — | 0.0059 | borrow kills |
| 70 | F1-don-4h-N20-k3 | edge-search (2y, train) | 250 | 0.129 | 6.12% | 0.673% | -0.797% | 0.17% | — | 0.0068 | borrow kills |
| 71 | R2b-rsi2pb-1d-k2-long | edge-search (2y, train) | 23 | 0.047 | 11.01% | 0.411% | -0.975% | 0.20% | — | 0.0031 | borrow kills |
| 72 | F1-don-4h-N55-k3-reg | edge-search (2y, train) | 105 | 0.087 | 6.37% | 0.468% | -0.907% | 0.17% | — | 0.0043 | borrow kills |
| 73 | F4-squeeze-4h-k3 | edge-search (2y, train) | 117 | 0.039 | 5.33% | 0.180% | -0.978% | 0.17% | — | 0.0001 | borrow kills |
| 74 | legacy-trend4h | swing study (85d, aggregate) ≈ | 149 | -0.061 | 2.96% | -0.182% | -1.142% | 0.20% | — | 0 | no gross edge |
| 75 | ctl-ema-pullback-1d | swing study (85d, aggregate) ≈ | 22 | -0.039 | 5.04% | -0.197% | -1.637% | 0.20% | — | 0 | no gross edge |
| 76 | F2-tsmom-1d-L60-k2 | edge-search (2y, train) | 106 | 0.063 | 10.69% | 0.587% | -3.745% | 0.18% | — | 0.0019 | borrow kills |
| 77 | F2-tsmom-1d-L20-k2 | edge-search (2y, train) | 116 | 0.024 | 10.74% | 0.225% | -3.948% | 0.17% | — | 0.0003 | borrow kills |
| 78 | F2-tsmom-1d-L60-k3 | edge-search (2y, train) | 68 | -0.060 | 16.03% | -0.836% | -8.245% | 0.18% | — | 0 | no gross edge |
| 79 | F2-tsmom-1d-L20-k3 | edge-search (2y, train) | 69 | -0.081 | 15.95% | -1.124% | -8.830% | 0.17% | — | 0 | no gross edge |

## Spot long/flat trend rules — break-even per side vs actual 0.15%/side

| symbol | rule | gross CAGR | net CAGR @0.15% | B&H CAGR | break-even per side (net = 0) | break-even per side (net = B&H) |
| --- | --- | --- | --- | --- | --- | --- |
| BTC | 4h SMA200 (Card 1) | 56% | 42% | 40% | 0.72% | 0.17% |
| BTC | 4h SMA840 ≈ 20-week (Card 4) | 47% | 44% | 22% | 2.58% | 1.27% |
| BTC | daily EMA20 (live spot tracker) | 51% | 42% | 38% | 1.01% | 0.22% |
| ETH | 4h SMA200 (Card 1) | 85% | 71% | 28% | 1.14% | 0.69% |
| ETH | 4h SMA840 ≈ 20-week (Card 4) | 43% | 39% | 13% | 2.01% | 1.33% |
| ETH | daily EMA20 (live spot tracker) | 66% | 56% | 26% | 1.22% | 0.67% |
| SOL | 4h SMA200 (Card 1) | 125% | 102% | 83% | 1.13% | 0.29% |
| SOL | 4h SMA840 ≈ 20-week (Card 4) | 131% | 121% | 116% | 2.98% | 0.24% |
| SOL | daily EMA20 (live spot tracker) | 113% | 99% | 71% | 1.68% | 0.49% |
