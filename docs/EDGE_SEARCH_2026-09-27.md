# Edge search — 2026-09-27 (research only)

Owner ask: keep searching for an edge until one is found. Research only: no engine, config,
payload or deploy change. Code: `scripts/research/edge/`. Outputs: `var/edge/` (gitignored).

## Protocol

- **Data:** `test/fixtures/history/deep2y-2026-09-26` (Binance 1m, 5m/1h/4h derived, 1d Kraken),
  BTC/SOL/ETH, 2024-10-01 → 2026-09-27. For the daily test, Binance 1d klines from
  `data-api.binance.vision` (BTC/ETH 2017-08-17 →, SOL 2020-08-11 →), `var/edge/daily-long/`.
- **Split:** search on entries before **2026-01-01**; **2026-01-01 → 2026-09-27 is the holdout**,
  run only for finalists.
- **Perps costs** (per trade, on notional): base long 0.20% / short 0.14% round trip + 0.02%/h
  borrow; harsh 0.34% / 0.14% + 0.024%/h; light 0.15% / 0.14% + 0.01%/h. Borrow is
  Jupiter's hourly fee on position size (`docs/MASTER_PLAN_T6_FEE_AWARE_FLAGS.md` D3), so
  multi-day holds pay ~0.5%/day. **Spot costs:** 0.15% per switch (0.10% swap + 0.05% slippage), no borrow.
- **Fills:** signal on a closed bar, entry at the next 5m open; stop and target in one 5m bar
  → stop; gaps through a stop fill at the open.
- **Trial ledger** (for multiple-testing honesty): round 1 38 configs, hour-of-day scan 24,
  round 2 14, spot trend 3 (+ EMA-length plateau 7, reported, not selected on).

## Perps results: no edge (76 configs, search period)

Round 1 (`run.js`, `families.js`): Donchian breakout + chandelier trail on 1h/4h (F1, 16),
daily time-series momentum (F2, 4), 1h RSI(2)/Bollinger mean reversion to SMA20 (F3, 8),
4h volatility squeeze breakout (F4, 4), US-open range breakout (F5, 6). Round 2
(`round2.js`): daily volatility breakout, flat by day end (R2a, 6), daily RSI(2) pullback with
trend (R2b, 4), 1h shock bars fade/follow (R2c, 4).

- **No config is net-positive with t ≥ 1.** Best: R2b daily RSI(2) pullback +0.03R (n=35, t 0.5);
  4h squeeze/Donchian −0.09R.
- **Gross edge is near zero everywhere.** Best gross +0.10–0.18R on 4h trend rules; 1h rules
  ≈ 0 gross. BTC/SOL/ETH price action at 1h–1d behaves close to a random walk for these rules
  over Oct 2024 – Dec 2025.
- **Borrow kills holding time.** 4h trend trades hold 30–77 h: 0.15–0.25R of borrow alone. Under
  light costs the 4h trend rules are only about breakeven.
- **Hour-of-day:** 01–05 UTC and 22 UTC are positive for all three symbols in both halves, but
  worth only ~10–25 bps over the window — under a 20–28 bps round trip. Not tradeable alone.
- Earlier studies agree (`CONDITIONS_`, `EXITS_`, `MEANREV_`, `VARIANTS_`, `COST_GATE_STUDY`):
  short-timeframe flag scalps have no gross edge; the one gross edge seen (1h zone-touch mean
  reversion, +0.41R on 60 days) is killed by costs at its 0.39% median stop. Its 2-year re-run
  is below.

## Found: spot trend filter (daily EMA20, long or cash)

Rule: hold the coin while the daily close is above EMA(20) of daily closes; otherwise hold
USDC. Decided on the UTC daily close, applied from the next day. `spot-trend.js`.

**Selection:** EMA20 was chosen on the 2024-10 → 2025-12 search period alone (average return
+22% vs +1% for EMA50 and +2% for EMA100). The 2026 holdout for all three lengths was printed
in the same check, so it is reported, not used to choose.

| Period | BTC | ETH | SOL |
| --- | --- | --- | --- |
| Search 2024-10 → 2025-12 (return vs buy & hold) | +20% vs +28% | +43% vs +17% | +2% vs −30% |
| Holdout 2026-01 → 2026-09 | **+10% vs −4%** | **+34% vs −10%** | **+3% vs −8%** |

**Out of sample 2017-08 → 2024-10** (never seen when EMA20 was chosen):

| | CAGR | B&H CAGR | max DD | B&H DD | trades | win % | avg win | avg loss |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 50% | 46% | 60% | 83% | 139 | 27% | 21% | 3% |
| ETH | 64% | 35% | 56% | 94% | 149 | 23% | 28% | 4% |
| SOL (2020-08 →) | 172% | 138% | 65% | 96% | 87 | 22% | 77% | 5% |

Every length from EMA15 to EMA50 beats buy & hold on CAGR and drawdown for all three coins
over 2017 → 2024 (EMA10/100/200 mixed), so EMA20 sits on a plateau, not a spike.

**Equal-thirds portfolio, 2017 → 2026:**

| | CAGR | max DD | Sharpe |
| --- | --- | --- | --- |
| Buy & hold | 50% | 88% | 0.92 |
| EMA20 filter | 73% | 56% | 1.39 |
| EMA20 + 60% vol target | 53% | 47% | 1.39 |
| EMA20 + 40% vol target | 39% | 37% | 1.37 |

By year (filter vs buy & hold): 2017 +120/+170, **2018 −4/−77**, 2019 +53/+42, 2020 +121/+188,
2021 +725/+1150, **2022 −37/−80**, 2023 +132/+294, 2024 +54/+90, **2025 −4/−14**, **2026 +15/−4**.
Vol target: each coin's weight = min(1, target / 20-day realized vol).

### Why this is the owner's "30% win, win big" profile

22–27% of trades win; the average win is 5–15× the average loss. Losses are small by
construction (exit on the first close under the EMA); winners are whole trends. The edge is
**avoiding crashes**, not beating rallies: it trails buy & hold in strong bull years.

### Caveats

- Three highly correlated coins; the portfolio is one bet on "crypto trends persist".
- Daily closes only; results assume execution near the close (Jupiter swap at the next minutes).
- 2017–2021 is a different market (much larger trends). 2024-10 → now, per coin: BTC +19%/yr vs
  +16%, ETH +36% vs +2%, SOL +8% vs −11% — still ahead, with smaller margins.
- Drawdowns stay large without the vol target (56%). Use the vol target for "keep losses small".
- Spot, not perps: this needs no leverage and pays no borrow. Perps with borrow at ~0.02%/h would
  cost ~175%/yr on the held notional; this does not work as a perps position.

## Files

- `scripts/research/edge/lib.js` — loader, indicators, 5m-path trade simulator, costs, stats.
- `scripts/research/edge/families.js`, `round2.js`, `run.js` — perps families and runner.
- `scripts/research/edge/spot-trend.js` — spot trend filter and EMA-length table.
- `scripts/research/edge/spot-portfolio.js` — equal-thirds portfolio, by year, vol targeting.
