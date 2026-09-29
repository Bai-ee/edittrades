# T-24 prediction rule replay - 2y history (deep2y-2026-09-26)

Generated 2026-09-29T03:54:48.133Z by `scripts/predictions/replay.js` against `test/fixtures/history/deep2y-2026-09-26`, symbols BTC/ETH/SOL, timeframes 5m/15m/1h/4h. Elapsed: 2.01 min.

`lib/predictionRule.js` `predictNextCandle` is a pure 5-vote rule (close vs EMA21, EMA21 vs EMA200, higher-tf close vs EMA21, Stoch RSI %K direction, last swing pivot) scored `over`/`under`/`no_call` at every closed candle, no lookahead (bounded fetch windows, same shape production itself sees - see this file's header). `n` counts only closes where the rule made a call (over/under) AND the next candle actually moved (excludes `no_call` and the rare exact-flat close). `sameAsLastRate` is the "guess the previous candle's own direction repeats" baseline, scored over the identical `n` denominator so it is directly comparable to `hitRate`.

## Per cell (symbol x timeframe)

| Cell | n | hits | misses | no_call | hitRate | coinFlip | sameAsLast | meanMoveBps(hit) | meanMoveBps(miss) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| BTC:5m | 135870 | 65899 | 69971 | 72679 | 48.5% | 50.0% | 49.2% | -0.26 bps | 0.3 bps |
| BTC:15m | 45690 | 21949 | 23741 | 23777 | 48% | 50.0% | 48.2% | -0.22 bps | 0.38 bps |
| BTC:1h | 11586 | 5650 | 5936 | 5631 | 48.8% | 50.0% | 48% | -0.27 bps | 0.87 bps |
| BTC:4h | 2871 | 1395 | 1476 | 1275 | 48.6% | 50.0% | 46.4% | -3.5 bps | 6.83 bps |
| ETH:5m | 136229 | 65118 | 71111 | 72398 | 47.8% | 50.0% | 48.9% | -0.62 bps | 0.61 bps |
| ETH:15m | 45590 | 21700 | 23890 | 23870 | 47.6% | 50.0% | 47.4% | -1.09 bps | 1.15 bps |
| ETH:1h | 11465 | 5509 | 5956 | 5746 | 48.1% | 50.0% | 47.6% | -3.43 bps | 3.4 bps |
| ETH:4h | 2891 | 1430 | 1461 | 1253 | 49.5% | 50.0% | 49.5% | -10.75 bps | 11.51 bps |
| SOL:5m | 133698 | 64803 | 68895 | 72069 | 48.5% | 50.0% | 48.1% | -0.64 bps | 0.81 bps |
| SOL:15m | 45616 | 22128 | 23488 | 23286 | 48.5% | 50.0% | 47.6% | -1.37 bps | 1.34 bps |
| SOL:1h | 11551 | 5590 | 5961 | 5588 | 48.4% | 50.0% | 47.5% | -4.85 bps | 4.97 bps |
| SOL:4h | 2769 | 1346 | 1423 | 1369 | 48.6% | 50.0% | 49.6% | -13.8 bps | 21.96 bps |

## By timeframe (all symbols)

| Timeframe | n | hitRate | coinFlip | sameAsLast |
| --- | ---: | ---: | ---: | ---: |
| 5m | 405797 | 48.3% | 50.0% | 48.8% |
| 15m | 136896 | 48.1% | 50.0% | 47.7% |
| 1h | 34602 | 48.4% | 50.0% | 47.7% |
| 4h | 8531 | 48.9% | 50.0% | 48.5% |

## By symbol (all timeframes)

| Symbol | n | hitRate | coinFlip | sameAsLast |
| --- | ---: | ---: | ---: | ---: |
| BTC | 196017 | 48.4% | 50.0% | 48.9% |
| ETH | 196175 | 47.8% | 50.0% | 48.5% |
| SOL | 193634 | 48.5% | 50.0% | 48% |

## Overall

n=585826, hits=282517, misses=303309, no_call=308941, hitRate=48.2%, coinFlip=50.0%, sameAsLast=48.5%, meanMoveBps(hit)=-0.86 bps, meanMoveBps(miss)=0.99 bps.

Best cell: **ETH:4h** at 49.5% (n=2891). Worst cell: **ETH:15m** at 47.6% (n=45590).

## Honest read

Overall this v1 rule reads as no better than a coin flip, and slightly worse than just assuming the last candle repeats, across 585,826 scored closes (308,941 additional closes were `no_call`). It is a simple 5-vote score with no walk-forward tuning, no per-symbol or per-timeframe calibration, and no weighting between votes - v1 is a starting instrument for the tracker to grade against going forward (docs/PROMPT_T24_PREDICTION_TRACKER.md Agent B), not a validated edge or a claim the engine should act on. The per-cell table above is the more honest read than the overall average: hit rate varies materially by timeframe and by symbol, and any cell with n below a few hundred closes should be read as noisy rather than as a settled result.
