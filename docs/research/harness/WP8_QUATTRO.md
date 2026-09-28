# WP8 — Quattro Donchian: results (research only, 2026-09-27)

Frozen rules: `docs/research/harness/WP8_QUATTRO_REGISTRATION.md` (read that first, including the 2026-09-27
cost-update addendum, §3b). Engine: `scripts/research/edge/quattro.js`. Tests: `test-quattro.js` (`node
test-quattro.js`, 4/4 pass — causality/append-future invariance, A-vs-B regime divergence on a constructed
fixture, a fully hand-computed entry/stop/exit/grossR trade, and the `perTradeBreakeven` closed-form formula).
Generated data: `var/research/wp8-quattro/{summary.json,REPORT.md}`. Reference source CSVs:
`var/research/wp8-quattro/reference/*.csv` (copied from `EstebanSP23/crypto_systematic_research` @ `5df0c43f`).

```
node scripts/research/edge/quattro.js --out var/research/wp8-quattro
node test-quattro.js
```

## Reproduction vs source

`quattro.js`, run at `maxLeverage=20` (matching source exactly — this validation pass is not the WP's official
no-leverage arm), reproduces **every one of the 400 reference trades across all six source CSVs** (single-unit
BTC/regime-A, pyramid BTC/regime-A, and pyramid BTC+ETH+SOL/regime-B) to within one 4h bar:

| check | ref n | our n | matched | rate |
| --- | --- | --- | --- | --- |
| 1U, BTC, regime A vs `backtest_trend.py` | 89 | 93 | 89 | 100% |
| Pyramid, BTC, regime A vs `backtest.py` | 94 | 98 | 94 | 100% |
| Pyramid, BTC, regime B vs `backtest_multi_asset.py` (locked) | 80 | 82 | 80 | 100% |
| Pyramid, ETH, regime B vs `backtest_multi_asset.py` (locked) | 74 | 77 | 74 | 100% |
| Pyramid, SOL, regime B vs `backtest_multi_asset.py` (locked) | 63 | 69 | 63 | 100% |

Our engine finds 3–6 *more* trades than each reference in every case, entirely explained by data: our
`var/edge/{4h-long,daily-long}` history runs through 2026-09-27, ~4 months past the source's own ~May 2026 cutoff,
and Quattro kept firing signals in that extra window. Every trade the source recorded, we recover at the same
entry date. This is strong reproduction confidence: our reading of the entry/exit/ATR/pyramid mechanics (registration
§1) is correct for **both** regime interpretations and all three symbols, not just BTC — contradicting Card 7's
"BTC-only" characterization, which only read the single-asset scripts and missed `backtest_multi_asset.py`.

## A (code) vs B (README rising-EMA200) regime

B (`close > EMA200` AND `EMA200[d] > EMA200[d-20]`) trades noticeably less than A on BTC (122 vs 145 full-history
trades) and modestly less on ETH/SOL, but the two are **not decisively different** — gross R/trade, win%, and net
CAGR land within a few points of each other in every window, and neither dominates the other across all three
symbols. The slope filter mostly skips a handful of whipsaw entries into a topping regime without changing the
strategy's character. Both interpretations show a real, reproducible gross edge on BTC/ETH/SOL across every window
tested (source_window, full_history, 2020–23, 2024–26) — the doc/code discrepancy Card 2/7 flagged does not change
the qualitative verdict either way.

## Spot vs perps verdict — reversed by the 2026-09-27 borrow measurement

Card 6/7's prior conclusion ("Quattro's core entry tolerates only ≈0.005%/h borrow against Jupiter's assumed
0.02–0.024%/h — dead on arrival on perps") was built on a **static** borrow assumption. Real Jupiter borrow measured
today via `perps-api.jup.ag/v1/pool-info` is **≈0.0015%/h (BTC/ETH/SOL base) and ≈0.004%/h at ~80% utilization
(stress)** — 13–16x lower than the old assumption. Re-costed at the real rate, the verdict flips:

**Break-even margin (full history, break-even round trip ÷ actual 0.20% RT; >1× survives):**

| arm | symbol | @0.0015%/h (base, real) | @0.004%/h (stress) | @0.02%/h (old static) | @0.024%/h (old static) |
| --- | --- | --- | --- | --- | --- |
| 1U_A | BTC | **9.46x** | 8.06x | n/a (negative) | n/a (negative) |
| 1U_A | ETH | **10.33x** | 8.96x | 0.16x (thin) | n/a (negative) |
| 1U_A | SOL | **14.99x** | 13.75x | 5.86x | 3.88x |
| 1U_B | BTC | **10.24x** | 8.85x | n/a (negative) | n/a (negative) |
| 1U_B | ETH | **7.76x** | 6.48x | n/a (negative) | n/a (negative) |
| 1U_B | SOL | **16.95x** | 15.70x | 7.68x | 5.68x |
| PYR_A | BTC | **12.94x** | 11.55x | 2.68x | 0.46x (thin) |
| PYR_A | ETH | **11.73x** | 10.40x | 1.83x (thin) | n/a (negative) |
| PYR_A | SOL | **16.32x** | 15.26x | 8.53x | 6.85x |
| PYR_B | BTC | **14.13x** | 12.75x | 3.94x | 1.74x |
| PYR_B | ETH | **8.46x** | 7.20x | n/a (negative) | n/a (negative) |
| PYR_B | SOL | **22.17x** | 21.09x | 14.15x | 12.41x |

At the real measured rate, every arm/symbol/regime combination survives perps costs with wide margin (6.5x–22x).
At the old 0.02–0.024%/h assumption, BTC and ETH single-unit arms were killed or left with no margin (matching
Card 6's finding) — only SOL reliably survived. **The perps verdict is base-rate dependent and now favorable**: net
CAGR at 0.0015%/h borrow tracks within 2–3 points of the spot-cost result in every row (e.g. BTC 1U_A full-history:
gross 20.90%, spot 19.02%, perp@0.0015 17.54%, perp@0.02 **-5.96%**). Full net-CAGR/Sharpe/maxDD tables for all
five cost scenarios (gross, spot, perp@0.0015, perp@0.004, perp@0.02, perp@0.024, source's own 0.06%/fill) ×
4 windows × 3 symbols × 4 arms are in `var/research/wp8-quattro/REPORT.md` / `summary.json`.

**Caveat:** the 0.0015%/0.004%/h figures are a point-in-time read of Jupiter's utilization-based curve, not a
historical series (Card 6.1 — measuring the *history* of Jupiter borrow — is still open). If utilization has spent
material time above ~80% historically, the realized cost could sit above the 0.004%/h stress case used here.

## vs SMA200 / SMA840 (already-registered spot trend rules, Card 1/Card 4)

This is the headline finding for prioritization. Run head-to-head on the same symbols/windows/cost models
(`runSma4h`, perp@0.0015%/h, QUATTRO_1U_A), **SMA200 and/or SMA840 beat Quattro's net CAGR in all 12 of 12
symbol×window cells** (all three symbols, all four windows; full table in `summary.json`):

| symbol | window | B&H | Quattro 1U_A (perp@0.0015) | SMA200 (perp@0.0015) | SMA840 (perp@0.0015) |
| --- | --- | --- | --- | --- | --- |
| BTC | full_history | 38.5% | 17.5% | **36.6%** | **35.4%** |
| BTC | 2020–23 | 55.5% | 27.2% | **54.9%** | **64.2%** |
| BTC | 2024–26 | 28.7% | 2.1% | **18.2%** | **23.1%** |
| ETH | full_history | 26.9% | 14.6% | **64.1%** | 31.3% |
| ETH | 2020–23 | 104.5% | 21.0% | **115.2%** | 69.7% |
| SOL | full_history | 83.7% | 17.6% | **96.5%** | **109.7%** |
| SOL | 2020–23 | 184.9% | 25.5% | **217.8%** | **302.1%** |

But raw net CAGR is not the whole comparison: Quattro trades far less often and holds far smaller drawdowns.
Full-history exposure (fraction of time with a position on) is **~20%** for Quattro across all three symbols vs
**~50–53%** for SMA200/SMA840; full-history maxDD is **18.9–28.1%** for Quattro vs **56.2–87.2%** for the SMA rules
(perp@0.0015%/h, full history). On a Calmar (CAGR/maxDD) basis the gap narrows sharply and roughly ties on BTC
(Quattro 0.63 vs SMA200 0.47 / SMA840 0.62) while SMA still leads clearly on ETH (1.14 vs 0.52) and SOL (1.11–1.51
vs 0.93). **Net: on raw return the already-registered SMA rules dominate everywhere tested; on drawdown-adjusted
return Quattro is competitive on BTC and behind on ETH/SOL.** Quattro's real value, if any, is as a much
lower-exposure / lower-drawdown diversifier alongside SMA200/840, not a higher-return replacement for them.

## Single-unit vs pyramid (normalized to ≤1x notional)

The pyramid arm (`maxLeverage=1` instead of source's 20x, per registration §2) has a higher gross edge per trade
(BTC gross R/trade 0.90 PYR_A vs 0.68 1U_A) and higher full-history net CAGR (BTC 27.2% vs 20.9% gross), but at a
real cost: **maxDD rises materially** (BTC 28.5% vs 21.9%; ETH 43.0% vs 25.1%; SOL 45.0% vs 18.3%), and in the most
recent window (2024–26) the BTC pyramid arm is roughly flat-to-negative even at spot costs (-0.4% at 0.15%/side)
while the single-unit arm stays clearly positive (+3.3%). Concentrating a capped 1x notional into a pyramided
campaign trades away exactly the tail-risk control that made the single-unit version's drawdown profile
competitive with B&H, without the leverage that made the source's own version's return profile compelling. The
no-leverage normalization changes the risk/return trade-off, not just its scale.

## Verdict

**PAPER CANDIDATE, low priority relative to the existing spot SMA200/SMA840 arms.**

- Reproduction: confirmed at 100% match rate against six independent source reference datasets, both regime
  interpretations, all three symbols.
- Gross edge: real and reproducible on BTC/ETH/SOL, all windows, both regimes, both unit structures.
- Costs: **the perps verdict flips from Card 6/7's REJECT-leaning conclusion to a clear survive**, now that real
  Jupiter borrow (≈0.0015%/h) replaces the old static 0.02–0.024%/h assumption. This is the single biggest change
  in this report relative to prior WP8-adjacent findings and should update Card 6.4/7's "spot or low-carry venue
  only" framing — Jupiter perps are no longer disqualifying for Quattro once real borrow is used.
- But: head-to-head against the harness's own already-registered SMA200/SMA840 spot trend rules, Quattro loses on
  net CAGR in most symbol/window cells, and the no-leverage pyramid variant trades better raw return for materially
  worse drawdown with no benefit in the most recent (2024–26) window.
- Recommendation: worth a small paper allocation (1-unit arm, either regime, spot or Jupiter perps) as an
  independent, lower-exposure signal for evidence-gathering — its lower time-in-market could be a useful
  diversifier alongside SMA200/840 rather than a replacement for them. It should **not** be prioritized ahead of
  Card 6.1 (real historical Jupiter borrow, to confirm 0.0015%/h isn't a favorable point-in-time snapshot) or
  ahead of building out the already-stronger SMA-based arms.

## Not done / flagged for a follow-up

- Card 6.1 (real *historical* Jupiter borrow, not a point-in-time read) still supersedes today's snapshot if it
  shows materially higher utilization in the past.
- Significance testing (Card 3.3/R3, block-bootstrap) was not run against Quattro's ~90–160 trades per arm; the
  break-even margins here are point estimates, not confidence intervals.
- Slippage is not modeled (matches the source's own omission, flagged in the deep-research report); the 0.20%
  round-trip and 0.15%/side figures are the harness's standing all-in assumptions, not a slippage-specific stress.
