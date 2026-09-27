# S1 Agent B - conditions study

Which subset of the live L0 rules' GOOD calls (`scripts/replay-rules.js` variant `L0`) has positive net expectancy, by selection field. Research only - no engine/config/lib change. `scripts/research/conditions.js`, `npm run study:conditions`.

## deep60 (2026-07-01 to 2026-09-24, 85.5 days)

Fixture: `test/fixtures/history/deep60-2026-09-24`. Symbols: BTC, SOL, ETH. Span: 2026-07-01T02:34:00.000Z - 2026-09-24T14:33:00.000Z.

L0 GOOD calls (first-ready close per candidateId, live config - minRR 2.5, net gate off): n = 881.

Scoring: fill window (15 candles) / stop / TP1 / 24h timeout close-out (mark-to-market at the hold limit, `scripts/swing/run.js` `scoreSignal`), net of direction-dependent round-trip cost (0.34% long / 0.14% short, `scripts/tracker/costs.js` `netR`). OOS 1st/2nd = net exp R over the first 2/3 vs last 1/3 of the fixture span by calendar time (same convention as `scripts/replay-rules.js`).

### Reading these tables: a stop-distance outlier problem

L0's 1m/3m/5m flag invalidation stop has no ATR or price floor (only `scripts/replay-rules.js`'s research-only V6 variant adds one) - the `stop distance bucket` table below shows the large majority of GOOD calls sit under 0.5% of entry, and a small number sit far tighter than that. The round-trip cost (0.34%/0.14% of entry, fixed) divided by a near-zero stop distance blows a losing trade's net R up by two to three orders of magnitude (worst single row on this fixture: -2193R on one 1m stop-out). That is a real property of these calls' economics, not a scoring artifact, but it means the MEAN net R column below can be dominated by one row in a bucket as large as 30-60 calls. Every table also reports **median net R**, which is far more robust to this; read the two together rather than the mean alone, and the two-field conjunctions below are ranked by median, not mean.

### Per-field tables

### symbol

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SOL | 323 | 267 | 21.72% | -0.0951 | -3.3443 | -2.6194 | -4.3855 | -2.0495 |
| BTC | 295 | 233 | 15.88% | 1.8925 | -24.5934 | -4.8426 | -36.7183 | -6.3408 |
| ETH | 263 | 209 | 20.57% | -0.0612 | -7.6883 | -2.8667 | -10.2661 | -3.9279 |

### direction

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| long | 486 | 391 | 19.69% | -0.1067 | -13.3868 | -3.8531 | -18.9087 | -4.9793 |
| short | 395 | 318 | 19.18% | 1.3977 | -9.4208 | -2.58 | -14.7736 | -2.7864 |

### flag timeframe

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1m | 670 | 557 | 17.95% | 0.7188 | -14.0776 | -3.6761 | -21.1321 | -4.5527 |
| 3m | 136 | 102 | 25.49% | 0.0286 | -2.9814 | -1.89 | -3.978 | -1.4367 |
| 5m | 75 | 50 | 24% | -0.0099 | -1.6944 | -1.73 | -1.7906 | -1.55 |

### hour of day (UTC)

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 | 57 | 45 | 17.78% | -0.2452 | -4.2914 | -3.1369 | -5.1545 | -2.9967 |
| 19 | 53 | 43 | 11.63% | -0.501 | -4.9854 | -3.9044 | -6.2262 | -3.2621 |
| 18 | 45 | 35 | 17.14% | -0.1703 | -3.2373 | -3.261 | -3.589 | -2.8197 |
| 23 | 44 | 39 | 25.64% | 0.0261 | -6.7302 | -4.1803 | -4.5614 | -8.7905 |
| 3 | 42 | 35 | 14.29% | -0.3592 | -4.5274 | -3.3824 | -5.4609 | -3.1272 |
| 0 | 40 | 33 | 24.24% | -0.0415 | -5.2303 | -2.6194 | -6.4338 | -3.5969 |
| 20 | 39 | 31 | 12.9% | -0.4621 | -20.2927 | -3.2262 | -36.2355 | -3.287 |
| 7 | 38 | 30 | 10% | -0.4762 | -3.7357 | -3.42 | -4.2947 | -2.6177 |
| 17 | 37 | 32 | 25% | 0.2549 | -3.0155 | -2.14 | -3.874 | -1.5847 |
| 15 | 37 | 33 | 18.18% | -0.1493 | -1.9077 | -1.9747 | -1.7778 | -2.0299 |
| 8 | 37 | 24 | 29.17% | 21.0837 | -24.1409 | -2.7 | -37.4162 | -2.0152 |
| 22 | 37 | 33 | 27.27% | 0.0927 | -5.7652 | -2.3027 | -5.5354 | -6.4831 |
| 12 | 36 | 31 | 16.13% | -0.3227 | -24.9396 | -3.0812 | -40.9007 | -2.8396 |
| 4 | 35 | 28 | 7.14% | -0.5795 | -7.2541 | -4.82 | -6.6447 | -7.7112 |
| 2 | 35 | 21 | 28.57% | 0.3413 | -5.1015 | -2.977 | -7.8274 | -3.0571 |
| 16 | 35 | 28 | 14.29% | -0.3067 | -3.3201 | -2.78 | -3.6621 | -2.7915 |
| 10 | 34 | 25 | 12% | -0.4975 | -6.014 | -3.7696 | -7.2293 | -4.6973 |
| 6 | 34 | 27 | 25.93% | 0.3848 | -7.441 | -4.4526 | -9.6553 | -3.6767 |
| 14 | 30 | 23 | 26.09% | 0.3477 | -3.5326 | -2.0074 | -4.6561 | -1.785 |
| 9 | 29 | 22 | 40.91% | 0.629 | -103.3382 | -3.31 | -162.267 | -0.2128 |
| 13 | 29 | 24 | 4.17% | -0.8247 | -4.7529 | -3.21 | -4.8062 | -4.6235 |
| 11 | 29 | 25 | 16% | -0.2681 | -13.1772 | -4.0013 | -20.1923 | -5.5774 |
| 1 | 26 | 22 | 18.18% | -0.315 | -46.3228 | -5.03 | -74.7574 | -5.2506 |
| 5 | 23 | 20 | 40% | 0.5912 | -5.0309 | -3.24 | -3.4644 | -7.9402 |

### flagRecommendation.clarity.gate.passable

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| passable | 643 | 519 | 19.65% | -0.1589 | -9.7029 | -2.6997 | -14.7393 | -3.0178 |
| blocked | 238 | 190 | 18.95% | 2.5538 | -16.8119 | -4.83 | -23.274 | -6.6822 |

### qualityBand

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| high | 781 | 631 | 19.33% | 0.6584 | -12.3753 | -3.0699 | -18.5066 | -4.0164 |
| medium | 100 | 78 | 20.51% | -0.1627 | -5.4008 | -3.52 | -6.7957 | -3.169 |

### setup.shadowNF.ready

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| absent | 832 | 668 | 19.16% | 0.598 | -12.1651 | -3.21 | -18.0582 | -4.0489 |
| not_ready | 43 | 39 | 25.64% | 0.1359 | -2.5523 | -2.0711 | -3.0367 | -1.8561 |
| ready | 6 | 2 | 0% | -1 | -2.112 | -2.11 | -2.112 | - |

### planned net R:R (flagTradePlan.netRR)

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| n/a | 328 | 259 | 16.22% | 1.6834 | -28.49 | -7.2815 | -37.814 | -9.065 |
| 0-0.5R | 192 | 160 | 22.5% | -0.0402 | -2.9659 | -3.27 | -2.9461 | -2.9907 |
| 0.5-1R | 140 | 114 | 19.3% | -0.1316 | -1.7507 | -2.36 | -1.7158 | -1.7845 |
| 1-1.5R | 95 | 80 | 25% | 0.0604 | -1.0315 | -1.74 | -0.8101 | -1.2761 |
| >=2R | 64 | 51 | 25.49% | 0.1284 | -0.5917 | -1.5535 | -0.4425 | -0.7469 |
| 1.5-2R | 62 | 45 | 11.11% | -0.515 | -1.4297 | -1.7444 | -1.723 | -1.0945 |

### topDown.sentiment

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| bull | 549 | 438 | 20.55% | -0.1087 | -3.4851 | -2.61 | -2.5463 | -3.9308 |
| bear | 324 | 265 | 17.74% | 1.7084 | -25.2082 | -4.7861 | -25.2082 | - |
| mixed | 8 | 6 | 16.67% | -0.3931 | -3.9011 | -2.7 | -3.9011 | - |

### topDown.aligned (0-4)

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 310 | 253 | 19.37% | 1.8043 | -9.9484 | -2.7678 | -12.5108 | -4.0915 |
| 4 | 236 | 183 | 16.94% | -0.3042 | -5.2264 | -2.8841 | -12.6864 | -3.3995 |
| 2 | 188 | 150 | 20% | -0.0765 | -6.035 | -4.16 | -7.4498 | -3.9128 |
| 1 | 147 | 123 | 22.76% | 0.109 | -31.3125 | -3.4887 | -33.9412 | -9.07 |

### room state

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| open | 579 | 466 | 18.67% | -0.2045 | -10.3579 | -2.67 | -16.1309 | -3.0715 |
| capped | 302 | 243 | 20.99% | 2.0496 | -14.0053 | -4.4526 | -18.8721 | -5.8761 |

### ema21Hold

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hold | 671 | 540 | 20.56% | 0.8596 | -13.8357 | -3.11 | -20.3915 | -4.0775 |
| wick | 175 | 144 | 15.97% | -0.359 | -4.4822 | -3.08 | -5.4854 | -3.3918 |
| reclaim | 35 | 25 | 16% | -0.3886 | -4.5331 | -3.1822 | -4.6243 | -4.4171 |

### stop distance bucket

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <0.5% | 841 | 680 | 18.82% | 0.5827 | -12.0918 | -3.24 | -17.7709 | -4.125 |
| 0.5-1% | 35 | 26 | 26.92% | 0.0681 | -0.4392 | -1.49 | -0.5029 | -0.3523 |
| 1-1.5% | 5 | 3 | 100% | 1.5786 | 1.2651 | 0.5897 | - | 1.2651 |

### ATR(15m) percentile regime (14-day trailing)

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| high | 431 | 343 | 19.24% | -0.1575 | -2.3766 | -2.2138 | -2.6176 | -2.0591 |
| mid | 246 | 201 | 18.91% | -0.1767 | -5.1825 | -4.0013 | -6.1355 | -3.9588 |
| low | 204 | 165 | 20.61% | 2.9838 | -38.6254 | -6.2786 | -56.3352 | -8.4316 |

### tier (lib/tier.js classifyTier)

| bucket | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 541 | 439 | 19.36% | -0.1636 | -10.851 | -2.7589 | -16.806 | -3.1188 |
| B | 340 | 270 | 19.63% | 1.7577 | -12.8387 | -3.75 | -17.6507 | -5.3939 |

### Best three two-field conjunctions (n >= 30)

Ranked by median net R (robust to the stop-distance outliers described above), not the mean.

| field A | bucket A | field B | bucket B | n | resolved | win % | gross exp R | mean net R (dir-cost) | median net R | OOS 1st (mean) | OOS 2nd (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ema21Hold | hold | stop distance bucket | 0.5-1% | 32 | 24 | 25% | -0.0123 | -0.5172 | -1.49 | -0.4271 | -0.6434 |
| flagRecommendation.clarity.gate.passable | passable | stop distance bucket | 0.5-1% | 34 | 25 | 28% | 0.1109 | -0.4058 | -1.4932 | -0.4479 | -0.3523 |
| qualityBand | high | stop distance bucket | 0.5-1% | 34 | 25 | 28% | 0.1109 | -0.3918 | -1.4932 | -0.4228 | -0.3523 |

(572 two-field combination(s) reached n >= 30, out of 1620 combinations evaluated across 15 fields.)

### Multiple-comparisons caveat

This run examined 65 single-field buckets (across 15 fields) and 1620 two-field bucket combinations - 1685 hypotheses total against 881 GOOD calls. At a naive 5% per-comparison significance level, a Bonferroni correction for this many comparisons would require roughly p < 2.97e-5 per bucket before treating any single row as a real effect rather than noise - none of the per-bucket sample sizes here are anywhere near large enough to support that. Every "best" row above is an exploratory lead, not a confirmed edge: it should be read as a candidate for a fresh out-of-sample check (a longer or different history window, e.g. deep2y once available) before it changes any engine rule.

## deep2y-2026-09-26 (symlinked; no second run)

`test/fixtures/history/deep2y-2026-09-26/manifest.json` landed (Agent H) before this run finished, and per this task's setup instructions the directory is symlinked into this worktree (`test/fixtures/history/deep2y-2026-09-26`). No second replay was run over it, for two concrete reasons found by inspecting its own manifest before spending the compute:

- Its `15m`/`1h`/`4h` files are explicitly `"copied from test/fixtures/history/deep60-2026-09-24"` (same ~85-day window, 2026-07-01 to 2026-09-24) - only `1m` and `1d` actually reach back to 2024-10-01. This study's candidate/geometry pipeline needs 15m/1h/4h coverage (`ENGINE_CONFIG.geometry.timeframes`) at every close it evaluates, so the replay's *eligible* span over `deep2y` is bounded by the same 85 days as `deep60-2026-09-24` regardless of how far back 1m/1d go - a second run would replay the identical window and reproduce the same 881 rows, not add out-of-sample coverage.
- `deep2y-2026-09-26` has no `BTC_5m.json`/`SOL_5m.json`/`ETH_5m.json` at all (H's own task scope copied only 15m/1h/4h/1d from `deep60`, per `docs/PROMPT_S1_EDGE_SEARCH.md` section H). `5m` is one of L0's own flag timeframes (`config/engine.js` `flag.timeframes: ['1m','3m','5m']`) - `loadHistoryDir` simply omits the missing file, `servedCount('5m', ...)` reads 0 forever, and this script's own eligibility gate (every replayed timeframe must clear `ENGINE_CONFIG.replay.minComputeCandles`) never opens - a second run against this fixture as packaged would silently score zero rows, not a bug in this script but a genuine gap in the fixture's current 5m coverage.

Confirmed by sampling `servedCount` at seven points spanning the full `deep2y` 1m range (see agent transcript) - every sample's bottleneck timeframe was `5m` at 0 served candles. Net effect: nothing to add here until `deep2y` also carries a 5m file and independently deep 15m/1h/4h/1d coverage; re-running this script against it costs the same as the deep60 run and would either error-free-silently to zero rows (missing 5m) or exactly reproduce this doc's numbers (5m fixed but 15m/1h/4h still only 85 days deep).
