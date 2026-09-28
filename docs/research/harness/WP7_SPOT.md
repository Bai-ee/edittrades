# WP7 — spot trend arm evidence: results (2026-09-27)

Research only. Frozen registration: `WP7_SPOT_REGISTRATION.md` (read first — windows, cost
model, exact rules, and why each design choice was made are there, not repeated here).
Full machine output: `var/research/wp7-spot/{summary.json,REPORT.md,commands.txt}`
(gitignored, regenerate with the commands below). Code: `scripts/research/edge/wp7-engine.js`
(engine, new), `scripts/research/edge/wp7-report.js` (CLI, new). Tests: `test-wp7-spot.js`,
7/7 passing, including an exact-reproduction cross-check against the existing `runSma4h`.

```
node scripts/research/edge/wp7-report.js --out var/research/wp7-spot
node test-wp7-spot.js
```

**Headline: does any arm beat plain weekly DCA? Yes, but unevenly.** `SLOW_SMA840_4H_V1` beats
plain DCA on every symbol and window tested, including BTC's hardest recent-regime cut. The two
faster/daily arms (`DONCHIAN_4W_V1`, `EMA20_DAILY`) **lose to plain DCA on BTC's common
(post-2020) window** despite one of them beating lump-sum buy-and-hold CAGR over the same
period — beating B&H and beating DCA are different questions for a contribution-funded
investor, and this study is the first place that distinction shows up with numbers.

## Parity check (before trusting any downstream number)

`SMA200_4H` and `SLOW_SMA840_4H_V1` computed by the new generic engine reproduce the existing,
unmodified `runSma4h()` **exactly** (0.0000pp diff, all three symbols) — the new engine is not
a second, divergent implementation.

`EMA20_DAILY` differs by 0.13–1.95pp CAGR from the existing `spot-trend.js` `runFilter()`. Read
the source and confirmed why: `runFilter()` charges a transition bar's **whole** close-to-close
return under the pre-transition position and applies the switch cost the same bar, while every
other WP7 engine (and Card 1's `runSma4h`) fills at the **next bar's open** (a partial-bar
return on the transition bar). Both are legitimate, already-existing conventions in this repo;
the gap is small and fully explained, not a bug. WP7 uses the next-open-fill reimplementation
everywhere for internal consistency across all four arms (needed anyway for DCA/overlay/
portfolio, which `runFilter()` doesn't expose a per-bar series or variable cost for).

## Item 1 — registered slow-trend variants (Card 1.6/4.4)

Net CAGR vs B&H CAGR, S3 cost (0.15%/side), **common window** (each strategy's own SOL-eligible
start → now):

| symbol | SMA200_4H | SLOW_SMA840_4H_V1 | DONCHIAN_4W_V1 | EMA20_DAILY |
| --- | --- | --- | --- | --- |
| BTC | 40.06% vs B&H 41.12% (no edge) | **36.77% vs 21.88%** (edge, maxDD 41%) | 28.29% vs 41.38% (no edge) | 28.92% vs 38.88% (no edge) |
| ETH | **62.72% vs 37.82%** | **42.12% vs 25.45%** | 40.07% vs 39.87% (~tied) | **51.35% vs 36.95%** |
| SOL | **102.31% vs 82.95%** | **121.41% vs 116.18%** (thin) | **101.65% vs 90.35%** | **101.27% vs 72.43%** |

2020–23 vs 2024–26 split (full history, S3) — BTC only shown, the hard case (ETH/SOL edges hold
up in both halves; see `var/research/wp7-spot/REPORT.md` for full tables):

| BTC strategy | 2020–23 net vs B&H | 2024–26 net vs B&H |
| --- | --- | --- |
| SMA200_4H | 51.17% vs 45.76% | 22.95% vs **28.71%** (loses) |
| SLOW_SMA840_4H_V1 | 50.11% vs 18.74% | **31.21% vs 28.71%** (only one that still wins) |
| DONCHIAN_4W_V1 | 56.00% vs 50.74% | 8.71% vs **28.71%** (loses badly) |
| EMA20_DAILY | 55.71% vs 43.20% | 16.91% vs **28.71%** (loses) |

SOL 2024–26 is the other weak spot: `DONCHIAN_4W_V1` goes **negative** (−16.23% vs B&H +6.67%)
and `EMA20_DAILY` also loses (2.74% vs 6.67%); only `SMA200_4H`/`SLOW_SMA840_4H_V1` hold a thin
edge there.

## Item 2 — DCA benchmark, $100/week Monday UTC (Card 4.1)

Money-weighted IRR, DCA-into-filter vs plain DCA (both net of 0.15%/side on every trade,
including weekly top-ups):

**Common window** (the fair, non-2018-dominated test):

| symbol | SMA200_4H | SLOW_SMA840_4H_V1 | DONCHIAN_4W_V1 | EMA20_DAILY |
| --- | --- | --- | --- | --- |
| BTC | 26.33% vs plain 25.95% (thin win) | **31.23% vs 24.04%** (clear win) | 10.75% vs 25.97% (**loses**) | 15.05% vs 26.32% (**loses**) |
| ETH | **35.54% vs 12.62%** | **27.06% vs 6.98%** | **20.59% vs 12.71%** | **31.82% vs 13.40%** |
| SOL | **72.97% vs 62.27%** | **56.25% vs 41.06%** | 62.75% vs 62.24% (razor-thin) | **82.73% vs 62.80%** |

Full history (dominated by BTC/ETH's 2017–18 cycle, before SOL existed — reported, not the
headline read): BTC's `DONCHIAN_4W_V1` and `EMA20_DAILY` **also lose to plain DCA here**
(29.07%/29.18% vs 36.26%), even though `EMA20_DAILY` beats lump-sum B&H CAGR over the identical
full history (Item 1: 42.79% vs 38.66%). Cost paid scales with the underlying filter's own
switch frequency applied to a *compounding, growing capital base* — `SMA200_4H`'s 61
switches/year cost $71k–$257k in absolute fees over the full run (vs $71 for a never-switching
plain DCA arm) precisely because every switch trades the *entire* accumulated position, not
just that week's $100. It still wins net on ETH/SOL because the underlying signal edge is large
enough to absorb it; on BTC in the shorter common window it does not clear that bar for two of
the four arms.

## Item 3 — vol-target (40%) + no-trade-buffer (0.10) overlay (Card 7.1)

Binary filter vs overlay, common window, S3 cost:

| symbol × strategy | binary CAGR / Sharpe / maxDD | overlay CAGR / Sharpe / maxDD |
| --- | --- | --- |
| BTC SMA200_4H | 40.06% / 1.05 / 46.02% | 33.18% / 1.14 / 39.09% |
| BTC EMA20_DAILY | 28.92% / 0.84 / 60.48% | 26.17% / 0.93 / 52.22% |
| ETH SMA200_4H | 62.72% / 1.20 / 44.51% | 33.95% / 1.10 / 38.55% |
| ETH EMA20_DAILY | 51.35% / 1.03 / 54.74% | 30.35% / 0.95 / 41.34% |
| SOL SMA200_4H | 102.31% / 1.26 / 87.30% | 36.69% / 1.17 / 52.47% |
| SOL EMA20_DAILY | 101.27% / 1.26 / 64.75% | 34.10% / 1.08 / 42.47% |

Pattern: the overlay **always** cuts maxDD substantially (roughly a third to a half) and
**always** gives up real CAGR — it is a risk-reduction tool, not a return-enhancer. Sharpe
improves in 3 of 6 rows here and is flat-to-worse in the other 3 (ETH SMA200 ties at
1.20→1.10 is actually a small loss; SOL SMA200 1.26→1.17 also a small loss) — the Sharpe
benefit is not universal at these parameters. `SENSITIVITY` rows at the source repo's own
targetVol=20% (portfolio-level, not registered) push this further: lower CAGR again, generally
higher Sharpe (full table in `var/research/wp7-spot/REPORT.md`).

## Item 4 — equal-weight BTC/ETH/SOL portfolio, EMA20-daily filter (Card 1.7)

Common window (2020-08-30 → now, 2219 trading days), S3 cost:

| arm | CAGR | Sharpe | maxDD | turnover/yr |
| --- | --- | --- | --- | --- |
| binary equal-weight-among-longs | 44.22% | 0.91 | 77.70% | 88.0 |
| vol-overlay equal-weight | 31.87% | **1.19** | **40.62%** | 28.8 |
| B&H fixed units, no rebalance | 53.71% | 0.94 | 91.38% | 0 |
| **B&H monthly-rebalanced** | **68.56%** | 1.08 | 84.78% | 1.2 |

Both baselines **beat both filtered arms on raw CAGR** — monthly-rebalanced B&H by a wide
margin (68.56% vs 44.22%/31.87%). The vol-overlay arm has the best Sharpe of the four (1.19)
and by far the best drawdown (40.62% vs 84–91% for everything else). There is no CAGR case for
wrapping this portfolio in either filter; there is a real Sharpe/drawdown case for the
vol-overlay version specifically.

## Item 5 — break-even per side, common window (Card 6.5)

| symbol | strategy | break-even (net=0) | break-even (beat B&H) | margin vs actual 0.15% |
| --- | --- | --- | --- | --- |
| BTC | SMA200_4H | 0.68% | 0.14% | **0.92x — already behind B&H** |
| BTC | SLOW_SMA840_4H_V1 | 1.90% | 0.80% | 5.31x |
| BTC | DONCHIAN_4W_V1 | 4.14% | 0.00% | **0.00x — no edge over B&H at any cost** |
| BTC | EMA20_DAILY | 0.78% | 0.00% | **0.00x — no edge over B&H at any cost** |
| ETH | SMA200_4H | 1.07% | 0.46% | 3.09x |
| ETH | SLOW_SMA840_4H_V1 | 2.23% | 0.89% | 5.96x |
| ETH | DONCHIAN_4W_V1 | +inf (never hits 0 by 5%) | 0.18% | 1.17x (thin) |
| ETH | EMA20_DAILY | 1.18% | 0.40% | 2.67x |
| SOL | SMA200_4H | 1.13% | 0.29% | 1.93x |
| SOL | SLOW_SMA840_4H_V1 | 2.98% | 0.24% | 1.57x |
| SOL | DONCHIAN_4W_V1 | +inf | 1.09% | 7.25x |
| SOL | EMA20_DAILY | 1.70% | 0.50% | 3.30x |

`SLOW_SMA840_4H_V1` has the largest, most consistent margins of any arm (1.6–6x beat-B&H, all
three symbols). `DONCHIAN_4W_V1` tolerates almost unlimited cost on its **own** turnover (near
zero switches) but frequently doesn't even clear buy-and-hold in the first place — cheap to run,
not necessarily worth running.

## Verdicts

| arm | verdict | why |
| --- | --- | --- |
| `SLOW_SMA840_4H_V1` | **PAPER CANDIDATE** | Only arm that beats B&H in *both* halves of BTC's train/test split, beats plain DCA on every symbol/window including BTC's common window, and has by far the largest cost margins (12–20x net=0, 1.6–6x beat-B&H). |
| `SMA200_4H` (comparator) | **INCONCLUSIVE on BTC, confirmed PAPER CANDIDATE on ETH/SOL** | No new verdict vs Card 1 — WP7 sharpens the same finding: it loses outright to B&H in BTC's 2024–26 regime and has a beat-B&H margin under 1x (0.92x) on BTC's common window. |
| `DONCHIAN_4W_V1` | **REJECT** | Frequently fails to beat plain buy-and-hold before any cost is even applied (BTC common window, BTC/SOL 2024–26 — SOL goes net negative there). Its DCA-into-filter loses to plain DCA on BTC and is a razor-thin, economically meaningless win on SOL. Cheap to run (near-zero turnover) but that headroom isn't buying anything. |
| `EMA20_DAILY` (comparator, = live tracker rule) | **No change recommended** (out of WP7's scope to touch); **new finding to flag** | Beats B&H and plain DCA clearly on ETH/SOL, but has a 0.00x beat-B&H margin on BTC's common window and its DCA-into-filter arm loses to plain DCA there too (15.05% vs 26.32% IRR) — despite beating lump-sum B&H CAGR over the longer full history. Worth the owner's attention since this is the arm already running live. |
| vol-target(40%)+buffer(0.10) overlay | **PAPER CANDIDATE for a risk-controlled mandate only** | Consistently and substantially cuts maxDD; Sharpe improves in half the tested rows and is flat/worse in the other half. Best framed as a drawdown-control feature, not a return enhancer — matches its role in the item-4 portfolio, where it produced the best Sharpe of any arm tested. |
| equal-weight BTC/ETH/SOL portfolio (binary or overlay) | **REJECT on CAGR, PAPER CANDIDATE on Sharpe/drawdown only** | Both filtered arms lose to both a fixed-unit and a monthly-rebalanced buy-and-hold baseline on raw CAGR (monthly B&H: 68.56% vs 44.22%/31.87%). The vol-overlay arm's Sharpe (1.19) and drawdown (40.62%) are the best of the four — a real trade-off, not a free win. |

## Caveats

- Spot only, no borrow/perps (out of scope per Card 6/1); no leverage, no shorting.
- `28` (Donchian) and `840` (SMA) are fixed before results were seen (Card 4's own exploratory
  20-week table motivated 840; not re-tuned here). `targetVol=40%`/`buffer=0.10` are the
  registered defaults, not fit to this data; the source repo's `targetVol=20%` is reported once
  as a labelled `SENSITIVITY` row only.
- DCA/portfolio use full-history and common windows only, not the 2020–23/2024–26 split (stated
  in the registration before running, not decided afterward).
- Max drawdown of DCA account value is peak-to-trough of total cash+coin value; ongoing
  contributions can mask a pure price drawdown in this metric — reported as specified, not
  corrected for it.
- Static-cost model throughout (0.15%/side, no slippage curve, no partial fills); consistent
  with every other spot study in this repo but not a claim about real fill quality at size.
- These are prior-informed choices (Card 1/4's own SMA family, Card 7's Trend Atlas pointer),
  so this counts as trials for Card 4.2's multiple-testing ledger, not a fresh blind test.
