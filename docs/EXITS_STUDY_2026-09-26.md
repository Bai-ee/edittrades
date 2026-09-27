# S1 agent C - exits study

Generated 2026-09-27T03:53:17.473Z by `scripts/research/exits.js`, fixture `test/fixtures/history/deep60-2026-09-24`, symbols BTC/SOL/ETH.

Population: 881 L0 signals (the live config verbatim - production's own `flagTradePlan`, first `ready` close per `candidateId`, same population `scripts/replay-rules.js --variant L0` scores at `--step 1`). Every variant re-walks the SAME signals' own 1m path under a different exit rule; `n` is identical across variants by construction - only management changes. Net R is direction-dependent (0.34% long / 0.14% short round-trip, `scripts/tracker/costs.js`), charged against each signal's ORIGINAL entry/stop risk regardless of how a variant's stop moved. Unresolved-at-24h trades score grossR=null (excluded from win %, contribute 0 to the expectancy sum) for fixed/be1r/trail1r/tp2; partial50 marks-to-market an already-armed remainder at the hold limit, and time force-closes at market by its own cutoff - see the file header of scripts/research/exits.js for the full per-variant convention.

`time` variant cutoff: 28 candles (0.47h) = 2x the median timeToTP1 among `fixed`'s own winners on this population.

## Data-quality flag: near-zero stop distance outliers

67 of 881 signals (7.6%) carry a `stopDistancePct` under 0.02% - a penny-level invalidation gap on a five-figure price (mostly BTC) that rounds to a near-zero risk denominator. Net R's cost term (`roundTripPct * entry / risk`) explodes as risk -> 0, so these ~8% of signals can move the population MEAN net R by double digits while every other row sits at +/- a few R - the exact artifact `docs/FREQUENCY_STUDY_2026-09-26.md` ("Data-quality flag: mean net expectancy is outlier-dominated") already found and flagged for the owner on this same fixture. **The tables below report both reads**: "full population" (every L0 signal, mean net R outlier-dominated) and "outlier-excluded" (`stopDistancePct >= 0.02%`, the honest read of whether management changes the sign) - the median net R column is included in both as a robustness cross-check regardless of which table is read. Same `candidateId` set is excluded across all six variants (the outlier flag is a property of the original signal, not of a variant's own management).

## Variants - outlier-excluded (headline)

| variant | n | win % | gross R | net R | median net R | max losing streak | median hold (h) | OOS 1st half net R | OOS 2nd half net R | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | 814 | 29.01% | 0.289 | -2.979 | -2.610 | 13 | 0.18 | -3.307 | -2.568 | fail |
| be1r | 814 | 22.54% | 0.314 | -2.955 | -2.410 | 7 | 0.15 | -3.290 | -2.535 | fail |
| trail1r | 814 | 55.04% | 0.419 | -2.851 | -2.310 | 7 | 0.12 | -3.224 | -2.384 | fail |
| partial50 | 814 | 56.14% | 0.222 | -3.048 | -2.310 | 7 | 0.15 | -3.416 | -2.586 | fail |
| time | 814 | 38.57% | 0.303 | -2.967 | -2.460 | 13 | 0.18 | -3.352 | -2.483 | fail |
| tp2 | 814 | 26.91% | 0.329 | -2.940 | -2.620 | 13 | 0.2 | -3.219 | -2.589 | fail |

## Variants - full population (reference, mean net R outlier-dominated)

| variant | n | win % | gross R | net R | median net R | max losing streak | median hold (h) | OOS 1st half net R | OOS 2nd half net R | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | 881 | 28.51% | 1.662 | -13.401 | -2.812 | 14 | 0.17 | -20.839 | -3.317 | fail |
| be1r | 881 | 22.53% | 1.712 | -13.351 | -2.607 | 7 | 0.13 | -20.788 | -3.270 | fail |
| trail1r | 881 | 55.28% | 1.356 | -13.708 | -2.519 | 7 | 0.12 | -21.535 | -3.098 | fail |
| partial50 | 881 | 56.3% | 0.922 | -14.142 | -2.530 | 7 | 0.13 | -22.122 | -3.323 | fail |
| time | 881 | 37.57% | 1.314 | -13.750 | -2.680 | 11 | 0.17 | -21.506 | -3.236 | fail |
| tp2 | 881 | 26% | 2.292 | -12.770 | -2.821 | 16 | 0.18 | -19.726 | -3.341 | fail |

Columns: n (signals scored, identical across variants within a table) · win % (share of resolved trades with grossR > 0) · gross R / net R (per-trade expectancy, unresolved counted as 0) · median net R (resolved trades only, robust to the outlier artifact above) · max losing streak (consecutive grossR < 0, chronological) · median hold hours (resolved trades) · OOS halves (first 2/3 vs last 1/3 of the fixture span, net R) · pass (net R > 0 in both halves AND n >= 20 - same rule as scripts/replay-rules.js's phase-0 OOS gate).

## Per-symbol appendix (outlier-excluded)

### fixed

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 254 | 26.38% | 0.238 | -3.853 | -3.450 |
| SOL | 313 | 31.51% | 0.371 | -2.295 | -2.157 |
| ETH | 247 | 28.57% | 0.237 | -2.947 | -2.494 |

### be1r

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 254 | 19.69% | 0.234 | -3.858 | -3.380 |
| SOL | 313 | 25.88% | 0.443 | -2.225 | -1.833 |
| ETH | 247 | 21.22% | 0.233 | -2.952 | -2.394 |

### trail1r

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 254 | 53.94% | 0.346 | -3.746 | -2.870 |
| SOL | 313 | 56.23% | 0.539 | -2.130 | -1.756 |
| ETH | 247 | 54.66% | 0.343 | -2.845 | -2.259 |

### partial50

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 254 | 53.94% | 0.156 | -3.935 | -3.230 |
| SOL | 313 | 58.79% | 0.309 | -2.359 | -1.756 |
| ETH | 247 | 55.06% | 0.180 | -3.008 | -2.304 |

### time

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 254 | 35.43% | 0.213 | -3.878 | -3.390 |
| SOL | 313 | 40.26% | 0.370 | -2.299 | -1.973 |
| ETH | 247 | 39.68% | 0.312 | -2.876 | -2.345 |

### tp2

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 254 | 23.62% | 0.183 | -3.909 | -3.480 |
| SOL | 313 | 30.23% | 0.509 | -2.157 | -2.157 |
| ETH | 247 | 26.12% | 0.250 | -2.934 | -2.530 |

## 2-year rerun (deep2y-2026-09-26, --step 20 per symbol)

Generated 2026-09-27T04:03:26.867Z by `scripts/research/exits.js`, fixture `test/fixtures/history/deep2y-2026-09-26`, symbols BTC/SOL/ETH.

Population: 127 L0 signals (the live config verbatim - production's own `flagTradePlan`, first `ready` close per `candidateId`, same population `scripts/replay-rules.js --variant L0` scores at `--step 1`). Every variant re-walks the SAME signals' own 1m path under a different exit rule; `n` is identical across variants by construction - only management changes. Net R is direction-dependent (0.34% long / 0.14% short round-trip, `scripts/tracker/costs.js`), charged against each signal's ORIGINAL entry/stop risk regardless of how a variant's stop moved. Unresolved-at-24h trades score grossR=null (excluded from win %, contribute 0 to the expectancy sum) for fixed/be1r/trail1r/tp2; partial50 marks-to-market an already-armed remainder at the hold limit, and time force-closes at market by its own cutoff - see the file header of scripts/research/exits.js for the full per-variant convention.

`time` variant cutoff: 54 candles (0.9h) = 2x the median timeToTP1 among `fixed`'s own winners on this population.

### Data-quality flag: near-zero stop distance outliers

6 of 127 signals (4.7%) carry a `stopDistancePct` under 0.02% - a penny-level invalidation gap on a five-figure price (mostly BTC) that rounds to a near-zero risk denominator. Net R's cost term (`roundTripPct * entry / risk`) explodes as risk -> 0, so these ~5% of signals can move the population MEAN net R by double digits while every other row sits at +/- a few R - the exact artifact `docs/FREQUENCY_STUDY_2026-09-26.md` ("Data-quality flag: mean net expectancy is outlier-dominated") already found and flagged for the owner on this same fixture. **The tables below report both reads**: "full population" (every L0 signal, mean net R outlier-dominated) and "outlier-excluded" (`stopDistancePct >= 0.02%`, the honest read of whether management changes the sign) - the median net R column is included in both as a robustness cross-check regardless of which table is read. Same `candidateId` set is excluded across all six variants (the outlier flag is a property of the original signal, not of a variant's own management).

### Variants - outlier-excluded (headline)

| variant | n | win % | gross R | net R | median net R | max losing streak | median hold (h) | OOS 1st half net R | OOS 2nd half net R | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | 121 | 38.33% | 0.772 | -1.593 | -1.840 | 11 | 0.25 | - | -1.593 | fail |
| be1r | 121 | 30.83% | 0.652 | -1.714 | -1.720 | 5 | 0.22 | - | -1.714 | fail |
| trail1r | 121 | 57.85% | 0.574 | -1.796 | -1.580 | 5 | 0.17 | - | -1.796 | fail |
| partial50 | 121 | 57.85% | 0.418 | -1.952 | -1.618 | 5 | 0.22 | - | -1.952 | fail |
| time | 121 | 42.15% | 0.588 | -1.782 | -1.744 | 16 | 0.25 | - | -1.782 | fail |
| tp2 | 121 | 35.83% | 0.714 | -1.651 | -1.910 | 11 | 0.28 | - | -1.651 | fail |

### Variants - full population (reference, mean net R outlier-dominated)

| variant | n | win % | gross R | net R | median net R | max losing streak | median hold (h) | OOS 1st half net R | OOS 2nd half net R | pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fixed | 127 | 37.3% | 0.728 | -209.390 | -1.950 | 12 | 0.24 | - | -209.390 | fail |
| be1r | 127 | 30.16% | 0.621 | -209.497 | -1.760 | 5 | 0.2 | - | -209.497 | fail |
| trail1r | 127 | 56.69% | 4.287 | -205.834 | -1.666 | 5 | 0.17 | - | -205.834 | fail |
| partial50 | 127 | 56.69% | 0.391 | -209.731 | -1.733 | 5 | 0.2 | - | -209.731 | fail |
| time | 127 | 40.94% | 0.552 | -209.569 | -1.897 | 17 | 0.25 | - | -209.569 | fail |
| tp2 | 127 | 34.92% | 0.887 | -209.230 | -2.050 | 12 | 0.25 | - | -209.230 | fail |

Columns: n (signals scored, identical across variants within a table) · win % (share of resolved trades with grossR > 0) · gross R / net R (per-trade expectancy, unresolved counted as 0) · median net R (resolved trades only, robust to the outlier artifact above) · max losing streak (consecutive grossR < 0, chronological) · median hold hours (resolved trades) · OOS halves (first 2/3 vs last 1/3 of the fixture span, net R) · pass (net R > 0 in both halves AND n >= 20 - same rule as scripts/replay-rules.js's phase-0 OOS gate).

### Per-symbol appendix (outlier-excluded)

#### fixed

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 38 | 34.21% | 0.679 | -2.520 | -2.430 |
| SOL | 41 | 39.02% | 0.643 | -0.830 | -1.580 |
| ETH | 42 | 41.46% | 0.982 | -1.500 | -1.897 |

#### be1r

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 38 | 28.95% | 0.640 | -2.559 | -2.400 |
| SOL | 41 | 31.71% | 0.629 | -0.844 | -1.332 |
| ETH | 42 | 31.71% | 0.684 | -1.798 | -1.897 |

#### trail1r

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 38 | 52.63% | 0.389 | -2.811 | -2.400 |
| SOL | 41 | 63.41% | 0.665 | -0.808 | -0.748 |
| ETH | 42 | 57.14% | 0.653 | -1.841 | -1.750 |

#### partial50

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 38 | 52.63% | 0.346 | -2.853 | -2.410 |
| SOL | 41 | 63.41% | 0.449 | -1.024 | -0.903 |
| ETH | 42 | 57.14% | 0.453 | -2.041 | -1.800 |

#### time

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 38 | 39.47% | 0.638 | -2.561 | -2.400 |
| SOL | 41 | 39.02% | 0.482 | -0.991 | -1.580 |
| ETH | 42 | 47.62% | 0.646 | -1.848 | -1.850 |

#### tp2

| symbol | n | win % | gross R | net R | median net R |
| --- | --- | --- | --- | --- | --- |
| BTC | 38 | 34.21% | 0.684 | -2.515 | -2.430 |
| SOL | 41 | 31.71% | 0.441 | -1.032 | -1.589 |
| ETH | 42 | 41.46% | 1.008 | -1.474 | -1.897 |

**Method note (performance)**: deep2y (`test/fixtures/history/deep2y-2026-09-26/`, ~1.05M 1m candles/symbol, Binance-sourced, Oct 2024-Sep 2026) is ~8.5x deep60's span. A single-symbol timing probe on this fixture measured ~47ms/close through the full production pipeline (vs ~9.5ms/close on deep60 - larger candle arrays cost more per close on this machine) - a `--step 1` run would take an estimated ~14h/symbol. Sampled at `--step 20` instead (same "does not fit the session, so said so" allowance `docs/FREQUENCY_STUDY_2026-09-26.md` used for its own oversized-fixture run), one process per symbol in parallel (~41 min/symbol, run concurrently).

**Important finding: this rerun did NOT actually exercise 2024-2025 history for signal generation**, and no `--step` choice would fix that. `deep2y`'s manifest records its 5m/15m/1h/4h files as `"copied verbatim from deep60-2026-09-24"` - only `1m` (this Binance backfill) and `1d` (Kraken's native ~2-year OHLC window) actually reach back to 2024-10. `5m`/`15m`/`1h` start 2026-07-01 and `4h` starts 2026-05-27, identical to `deep60`. `scripts/replay.js`'s `replaySymbol` only starts a replay once **every** replayed timeframe (`services/scalpContext.js` `TIMEFRAMES`, includes `15m`/`1h`/`4h`) has `minComputeCandles` (200) closed candles - so the production pipeline's own first-eligible close on `deep2y` cannot be earlier than mid-2026 regardless of the 1m/1d depth, and confirmed empirically: all 127 scored signals across all three symbols fall between 2026-07-10 and 2026-09-24 - the exact same window `deep60` already covers. The 2/3-1/3 OOS split above is close to degenerate as a result (nearly the whole population lands in the "second half"; the "OOS 1st half" column is `-` for every variant, n≈0) - **treat this section as a second, coarser, independently re-derived sample of the SAME July-September 2026 window, not a genuine long-history rerun.** This limitation is not specific to the exits study: any other S1 agent replaying `deep2y` through `scripts/replay.js`/`scripts/replay-rules.js`/`scripts/swing/run.js` (all of which require `15m`/`1h`/`4h` alongside `1m`) will hit the identical ceiling. Fixing it would mean deep-backfilling `5m`/`15m`/`1h` themselves (`4h`/`1d` already reach far enough via Kraken's native window) - a `scripts/replay.js` change outside this worktree's hard rules (research-only, no `lib/`/`scripts/replay.js` edits).
