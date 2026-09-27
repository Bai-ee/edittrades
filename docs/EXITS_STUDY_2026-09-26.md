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

