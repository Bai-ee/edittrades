# WP6 (Card 6.1) — real Jupiter Perps borrow rates (research, read-only)

Question: the "borrow kills" verdict for 21 strategies in `docs/research/BREAKEVEN_COSTS_2026-09-27.md`
assumes a flat ≈0.02–0.024%/h Jupiter borrow. Is that still the real rate?

**Script:** `scripts/research/edge/jupiter-borrow.js` (read-only; public RPC only, no wallet/keypair/env).
**Command:** `node scripts/research/edge/jupiter-borrow.js` (live) or `--fixture scripts/research/edge/fixtures/jupiter-custody-2026-09-27.json` (offline).
**Output:** `var/research/wp6-borrow/borrow.json`.
**Fixture (committed, public on-chain data, no secrets):** `scripts/research/edge/fixtures/jupiter-custody-2026-09-27.json` — raw base64 account bytes for the 5 custodies, captured 2026-09-27T20:2x UTC.
**Tests:** `test-jupiter-borrow.js` (8/8 pass) — fixture decode, %/h math, jump-rate curve math, CLI end-to-end.

## Method

1. Public RPC (`https://api.mainnet-beta.solana.com`, hardcoded, never read from env) → `fetchPool` on the Jupiter Perps pool (`5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq`, from `services/jupiterPerps.js` — read-only reference, not imported to avoid its wallet/`.env` deps) → `fetchAllCustody` for SOL, ETH, BTC, USDC, USDT, using `jup-perps-client` (already a dependency; same decoder the live app uses).
2. Decoded fields: `Custody.assets.{owned,locked}` (utilization), `Custody.fundingRateState.hourlyFundingDbps` (the legacy scalar the app's `getPerpQuote` currently reads), `Custody.jumpRateState.{minRateBps,maxRateBps,targetRateBps,targetUtilizationRate}` (the utilization-based curve — **not documented** on `developers.jup.ag/docs/perps/custody-account`, which only documents `hourlyFundingDbps`/`cumulativeInterestRate`/`lastUpdate`).
3. Cross-checked against public governance history: Jupiter's risk partners (Gauntlet, Chaos Labs) post dated, numeric borrow-rate recommendations on `discuss.jup.ag` (no login needed).

## Finding 1 — the legacy `hourlyFundingDbps` field is dead (reads 0 on every custody)

Live read, 2026-09-27:

| Custody | `hourlyFundingDbps` (raw) |
| --- | --- |
| SOL / ETH / BTC / USDC / USDT | **0** |

The app's own `getPerpQuote()` (`services/jupiterPerps.js:452`) computes `fundingRatePerHour = hourlyFundingDbps / 1_000_000` and returns it as the quote's borrow-rate field — so **that field currently always reports 0%/h**, not because borrow is free, but because Jupiter has moved the real rate onto a separate curve (`jumpRateState`) that this quote path never reads. This isn't in scope to fix (engine freeze), but it's a real staleness bug worth a ticket later: `fundingRate`/`fundingRatePerHour` in `getPerpQuote()`'s return value is not the real cost.

Also note: the app's code comment ("`hourlyFundingDbps` is deci-bps, 1 dbps = 1e-5 as a fraction") implies a `/100_000` conversion, but the code itself divides by `1_000_000` — a 10x internal inconsistency. Moot today since the field is 0, but worth fixing alongside the above if this field is ever revived.

## Finding 2 — the real rate is `jumpRateState`, a two-slope (Compound-style) curve, target = 80% utilization

Decoded curve parameters (live, 2026-09-27) and current pool utilization (`locked/owned`):

| Custody | min rate (APR) | target rate (APR) | max rate (APR) | target utilization | **current utilization** |
| --- | --- | --- | --- | --- | --- |
| SOL | 10% | 35% | 150% | 80% | 9.8% |
| ETH | 10% | 23% | 90% | 80% | 8.7% |
| BTC | 10% | 20% | 80% | 80% | 12.5% |
| USDC (short collateral) | 0% | 8.5% | 15% | 90% | 16.0% |
| USDT | 10% | 10% | 1500% | 80% | 0% (custody effectively unused: `owned`=1) |

Curve: linear from min-rate at 0% utilization to target-rate at target-utilization, then a steeper linear leg from target-rate to max-rate as utilization runs from target to 100% (`jumpRateAprAt()` in the script, unit-tested).

**Unit inference, not documented:** `minRateBps`/`maxRateBps`/`targetRateBps` are annualized (APR), not per-hour — a literal 35%/hour reading is nonsensical (compounds to astronomical numbers in days), while 35% APR matches Gauntlet/Chaos Labs' public 2024 recommendations (10–150% APR range, see below). `targetUtilizationRate` is a separate 1e9-scale fixed-point fraction (raw `800_000_000` → 80%), confirmed against every public Gauntlet/Chaos Labs post since May 2024 stating an 80% (90% for stables) target. Three independent signals agree (unit sanity check, the 80%/90% match to public posts, and the dead legacy field pointing at a newer mechanism) — confidence is high but this remains an inference, since `developers.jup.ag` does not document `jumpRateState` at all.

## Finding 3 — current effective rate: 0.0013–0.0015%/h for BTC/ETH/SOL longs, ~15–18x below the 0.02–0.024%/h assumption

Converting APR → %/h at **today's actual utilization** (`APR / (24×365)`):

| Custody | Current rate | vs. 0.02%/h assumption | vs. 0.024%/h assumption |
| --- | --- | --- | --- |
| SOL | **0.00149%/h** (13.1% APR) | 13.4x lower | 16.1x lower |
| ETH | **0.00130%/h** (11.4% APR) | 15.3x lower | 18.4x lower |
| BTC | **0.00132%/h** (11.6% APR) | 15.2x lower | 18.2x lower |
| USDC (short) | **0.00017%/h** (1.5% APR) | 117x lower | 141x lower |

**Structural cap, not just a snapshot:** because utilization is far below each curve's 80% target today, and even at the curve's mathematical ceiling (100% utilization → max-rate), the rate cannot exceed:
- BTC: 80% APR → **0.00913%/h** (still 2.2–2.6x below the 0.02–0.024% assumption)
- ETH: 90% APR → **0.01027%/h** (still 2.0–2.3x below)
- SOL: 150% APR → **0.01712%/h** (still 1.2–1.4x below)

So under the *current* on-chain curve, BTC/ETH long borrow can never reach the 0.02%/h figure used in the breakeven doc, and SOL only approaches it at 100% pool utilization (a stress condition Jupiter's target-utilization control tries to avoid).

## Finding 4 — public history (no RPC keys, no archival node): rates have fallen steadily, always via governance posts, never fetched from chain history

Historical on-chain state (e.g. `cumulativeInterestRate` at a past slot) is **not feasible** from a public non-archival RPC endpoint within this WP's timebox: `getAccountInfo` only returns current state, and Solana public RPC does not serve arbitrary historical account snapshots. Sampling `getSignaturesForAddress` + `getTransaction` only recovers instruction logs, not full post-account byte state, without an indexer. Stating this plainly per the WP charter's escape hatch.

Instead, dated numeric rates from Jupiter's own risk partners' public posts on `discuss.jup.ag` (no login required):

| Date | Source | Rate structure | Notes |
| --- | --- | --- | --- |
| 2024-05-03 | Gauntlet, [`t/16122`](https://discuss.jup.ag/t/jupiter-perpetuals-trading-fee-borrowing-rate-recommendations/16122) | Flat 0.01%/h all assets → recommended SOL 0.016%/h (140% APR), ETH 0.010%/h (88% APR), BTC 0.012%/h (104% APR), stables 0.003%/h (23% APR) | Target utilization 65% proposed |
| 2024-05-31 | Chaos Labs, [`t/17725`](https://discuss.jup.ag/t/chaos-labs-jupiter-price-impact-fee-borrowing-rate-recommendations/17725) | Endorses a jump-rate model, ~80% target utilization | No numeric table extracted |
| 2024-08-19 | Gauntlet, [`t/21580`](https://discuss.jup.ag/t/gauntlet-jupiter-perpetuals-optimization-borrowing-rate-reduction-and-competitive-analysis-vs-okx-and-bybit/21580) | Flat 0.01%/h → recommended 0.008%/h for SOL/ETH/BTC (20% cut) | Utilization then: SOL 45%, ETH 23%, BTC 49%; target moved to 80% |
| 2025-02-20 | Community proposal, [`t/35464`](https://discuss.jup.ag/t/dynamic-borrow-fees-adjustment-proposal/35464) | References a current base ≈0.003%/h (~30% APR), "historical highs ~50% APR, recent lows ~5% APR"; proposes floor 0.0001%/h (1% APR), ceiling 0.05%/h (400%+ APR), 80% target/asset | Confirms the flat-rate model was being replaced by a utilization-reactive one |
| **2026-09-27 (this WP, on-chain)** | Live `jumpRateState` | SOL 10–150% APR (target 35% @ 80% util); ETH 10–90% (target 23%); BTC 10–80% (target 20%) | Legacy flat `hourlyFundingDbps` field is now 0 (dead) |

Trend: the flat-rate model (0.01%/h in 2024) was replaced by a jump-rate/utilization curve targeting 80% utilization; recommended/observed rates fell from ~0.008–0.016%/h (2024) toward ~0.003%/h base (early 2025), and today's live curve floors even lower still (min 10% APR ≈ 0.0011%/h) with headroom that caps well under the 0.02–0.024%/h figure even under stress. This is corroborating, dated, public evidence for the same conclusion as Finding 3 — it is not a chain-verified time series, and is flagged as such.

## Re-evaluated verdict for the "borrow kills" group (21 strategies)

Applying the **measured current long-side rate (≈0.0013–0.0015%/h)** against each strategy's `max borrow %/h` column (`docs/research/BREAKEVEN_COSTS_2026-09-27.md`, the hourly borrow at which net R = 0 given actual fees):

- **19 of 21** now clear the fees-only bar and would be reclassified **`fees-and-borrow survive` at today's rate** (their `max borrow` exceeds 0.0013–0.0015%/h): `R2b-rsi2pb-1d-k2` (0.0181), `V2` (0.0145), `re-flag-breakout-4h` (0.0137), `V3b` (0.0119), `V3a` (0.0036), `F4-squeeze-4h-k2-reg` (0.0109), `V4` (0.0028), `F1-don-4h-N55-k2` (0.0096), `R2b-rsi2pb-1d-k3-long` (0.0145), `F1-don-4h-N55-k2-reg` (0.0063), `F1-don-4h-N20-k2` (0.0049), `F1-don-4h-N20-k2-reg` (0.0050), `F4-squeeze-4h-k3-reg` (0.0107), `F1-don-4h-N20-k3-reg` (0.0103), `F1-don-4h-N55-k3` (0.0059), `F1-don-4h-N20-k3` (0.0068), `R2b-rsi2pb-1d-k2-long` (0.0031), `F1-don-4h-N55-k3-reg` (0.0043), `F2-tsmom-1d-L60-k2` (0.0019).
- **2 of 21 still fail even at today's rate:** `F4-squeeze-4h-k3` (tolerates only 0.0001%/h) and `F2-tsmom-1d-L20-k2` (0.0003%/h) — both below even the curve's *floor* rate (~0.0011–0.0015%/h at 0% utilization), so they cannot survive under this borrow model at any utilization level.
- **Stress test (100% pool utilization, the curve's own ceiling — a harder bar since the stress rate is higher than today's measured rate):** of the 19 reclassified rows, the number that would *still* survive if their custody were pinned at 100% utilization depends on which symbol backs the strategy, since each custody's ceiling differs: **9 survive** at BTC's ceiling (0.00913%/h, the lowest of the three — easiest to clear), **8 survive** at ETH's ceiling (0.01027%/h), and only **1 survives** at SOL's ceiling (0.01712%/h, the highest — hardest to clear). The doc does not record which symbol(s) back each row, so this range (1–9 of 19) is reported rather than a single number; today's measured (non-stress) rate is the more realistic comparison, since pool utilization sits at 9–16% today, nowhere near 100%.

**Caveats carried over unchanged from the breakeven doc:** these are prior-inspected, aggregate-approximate results (many `n < 30`), not re-validated on holdout data; this WP only re-costs the borrow assumption, it does not re-run or re-test any strategy. The reclassification says the *borrow* leg of the original "fees kill vs. borrow kills" split was miscalibrated by roughly an order of magnitude at current market conditions — it does not promote any strategy to "validated edge."

## Bottom line

- The 0.02–0.024%/h Jupiter borrow assumption used across the research build (`docs/research/BREAKEVEN_COSTS_2026-09-27.md`, `docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md` D3, `docs/REVIEW_PACKET_2026-09-24.md:179`) is **≈13–18x higher than the measured live on-chain rate** for BTC/ETH/SOL longs as of 2026-09-27, and is not reachable at all for BTC/ETH even under 100% utilization stress given the current `jumpRateState` curve.
- The practical implication: **borrow is not the binding constraint it was assumed to be** for most of the "borrow kills" group of slower Donchian/squeeze/momentum strategies on Jupiter perps. Fees (round-trip 0.14–0.20%) become the dominant, harder-to-avoid cost again for most of these.
- This does not resurrect the `F2-tsmom` (daily time-series momentum, multi-week holds) or `F4-squeeze-4h-k3` strategies — their holding periods are long enough that even today's much-lower rate isn't the reason they fail, or (for `F4-squeeze-4h-k3`/`F2-tsmom-1d-L20-k2`) they need a rate below the curve's own floor.
- Recommend: if any of the 19 reclassified strategies moves toward a paper-candidate decision, re-run `scripts/research/edge/breakeven.js` with the measured 0.0013–0.0015%/h (or a small safety margin, e.g. 0.003%/h to cover the historical 2024 "high-utilization" range) instead of the flat 0.02–0.024%/h, rather than trusting this manual re-classification.

## Orchestrator verification (2026-09-27)

Two independent checks of the long-side rate:

| Custody | WP6 model %/h | Jupiter API `longBorrowRatePercent` (`perps-api.jup.ag/v1/pool-info`) | Realized on-chain accrual (Δ`cumulativeInterestRate`/Δ`lastUpdate`, 85–356 s window, 1e9 scale) |
| --- | --- | --- | --- |
| SOL | 0.00149 | 0.0015 | 0.00151 |
| ETH | 0.00131 | 0.0013 | 0.00132 |
| BTC | 0.00132 | 0.0013 | 0.00132 |
| USDC (short side) | 0.00017 | 0.0006 (`shortBorrowRatePercent`) | 0.00065 |

- The long side is confirmed three ways.
- The short-side model under-reads by about 4×, so use the API or realized value (≈0.0006%/h). Shorts are still far below the old assumption.
