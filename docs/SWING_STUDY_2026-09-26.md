# S0 swing-trade research - study results

Generated 2026-09-27T02:16:11.280Z by `scripts/swing/run.js` (Agent S0-A harness), fixture `test/fixtures/history/deep60-2026-09-24`.

Columns: n (signals inside 1m coverage) · resolved (win/loss, or timeout = closed at the hold limit, mark-to-market) · win % · gross exp R · net exp R (0.34% long / 0.14% short direction cost) · 0.20% sensitivity net R · max losing streak (resolved trades) · median hold (hours) · signals/week · OOS first/second half net R (dir-cost) · pass/fail (net > 0 in both halves).

## ctl-4h-range-break - Control: prior-24h range breakout (4h, 1D-bias-aligned)

Source: docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C. tf=4h, holdMaxHours=24, stopKind=structure. Runtime: 4673ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 43 | 43 | 41.86% | -0.026 | -0.1835 | -0.1801 | 6 | 14.83 | 1.427% | 16 | 3.52 | -0.2091 | -0.1591 | fail |
| SOL | 40 | 39 | 48.72% | 0.1107 | 0.0199 | 0.0149 | 7 | 24 | 2.26% | 23 | 3.28 | 0.1363 | -0.0906 | fail |
| ETH | 37 | 37 | 43.24% | 0.0351 | -0.0983 | -0.0846 | 5 | 21.9 | 1.928% | 18 | 3.03 | -0.2467 | 0.0423 | fail |
| combined | 120 | 119 | 44.54% | 0.0378 | -0.0903 | -0.0865 | 7 | 22.3 | 1.88% | 57 | 9.82 | -0.0551 | -0.125 | fail |

## ctl-donchian-20d - Control: 20-day Donchian breakout (1D, EMA200-aligned)

Source: docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C. tf=1d, holdMaxHours=72, stopKind=structure. Runtime: 1250ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 2 | 2 | 100% | 0.2455 | 0.2252 | 0.2336 | 0 | 72 | 17.31% | 2 | 0.16 | 0.427 | 0.0235 | pass |
| SOL | 4 | 3 | 66.67% | 0.1351 | 0.1186 | 0.1254 | 1 | 72 | 18.02% | 3 | 0.33 | 0.2517 | 0.052 | pass |
| ETH | 2 | 2 | 50% | 0.1892 | 0.1732 | 0.1798 | 1 | 72 | 22.05% | 2 | 0.16 | 0.409 | -0.0627 | fail |
| combined | 8 | 7 | 71.43% | 0.1821 | 0.1646 | 0.1718 | 1 | 72 | 18.98% | 7 | 0.65 | 0.2341 | 0.1126 | pass |

## ctl-ema-pullback-1d - Control: EMA21/EMA200 pullback-and-reclaim (1D)

Source: docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C. tf=1d, holdMaxHours=72, stopKind=atr. Runtime: 1264ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 9 | 9 | 44.44% | -0.0927 | -0.141 | -0.1399 | 2 | 72 | 4.206% | 7 | 0.74 | -0.4622 | 0.116 | fail |
| SOL | 8 | 8 | 25% | -0.0352 | -0.0689 | -0.0678 | 5 | 72 | 6.77% | 7 | 0.66 | -0.159 | 0.0212 | fail |
| ETH | 5 | 5 | 20% | 0.0516 | 0.0167 | 0.0113 | 4 | 72 | 5.293% | 5 | 0.41 | -0.2942 | 0.2239 | fail |
| combined | 22 | 22 | 31.82% | -0.039 | -0.0789 | -0.0793 | 5 | 72 | 5.04% | 19 | 1.8 | -0.1437 | -0.0142 | fail |

## ctl-random-4h - Control: seeded random long/short (4h) - null baseline

Source: docs/PROMPT_S0_SWING_RESEARCH.md Agent S0-C. tf=4h, holdMaxHours=24, stopKind=structure. Runtime: 4465ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 251 | 247 | 35.22% | 0.1056 | -4.8457 | -6.187 | 14 | 12.72 | 0.655% | 82 | 20.55 | -8.6803 | -1.0422 | fail |
| SOL | 250 | 246 | 31.71% | -0.0203 | -0.625 | -0.5709 | 16 | 10.14 | 1.11% | 66 | 20.49 | -0.688 | -0.5621 | fail |
| ETH | 236 | 231 | 34.2% | 0.312 | -0.7035 | -0.5682 | 14 | 9.85 | 0.87% | 68 | 19.35 | -1.2829 | -0.129 | fail |
| combined | 737 | 724 | 33.7% | 0.1287 | -2.09 | -2.486 | 16 | 10.57 | 0.828% | 216 | 60.34 | -3.5037 | -0.6763 | fail |

## legacy-swing - Legacy SWING (services/strategy.js)

Source: services/strategy.js evaluateAllStrategies -> evaluateSwingSetup (spec §1). tf=4h, holdMaxHours=72, stopKind=structure. Runtime: 7523ms.

- Calls the real evaluator (evaluateAllStrategies) with marketData/dflowData nulled - both only adjust confidence/volume gates, guarded by truthy checks in services/strategy.js, so null is a safe no-op.
- Production never supplies a 3D timeframe (services/scalpContext.js requests 1m/3m/5m/15m/1h/4h/1d only), so SWING is dead code live regardless of market conditions; this rule synthesizes 3D from 1D with the codebase's own (unused) bucketing (services/marketData.js aggregate3DayCandles) over the full available 1D history, so bucket edges stay stable across the replay instead of rolling with a fixed-window fetch.
- entry/stop/tp1/tp2 collapse the evaluator's entryZone {min,max} to its midpoint since the rule interface takes a single entry price, not a zone.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 0 | 0 | - | - | - | - | 0 | - | - | 0 | 0 | - | - | fail |
| SOL | 0 | 0 | - | - | - | - | 0 | - | - | 0 | 0 | - | - | fail |
| ETH | 0 | 0 | - | - | - | - | 0 | - | - | 0 | 0 | - | - | fail |
| combined | 0 | 0 | - | - | - | - | 0 | - | - | 0 | 0 | - | - | fail |

## legacy-trend4h - Legacy TREND_4H (services/strategy.js)

Source: services/strategy.js evaluateAllStrategies -> evaluateStrategy(setupType='4h') (spec §2). tf=4h, holdMaxHours=48, stopKind=structure. Runtime: 7151ms.

- Calls the real evaluator (evaluateAllStrategies) with marketData/dflowData nulled - both only adjust confidence/volume gates, guarded by truthy checks in services/strategy.js, so null is a safe no-op.
- No missing-timeframe gap: TREND_4H's evaluator path only reads 4h/1h/15m/5m, all of which production supplies live, so this rule scores production behavior exactly, no synthesized inputs.
- entry/stop/tp1/tp2 collapse the evaluator's entryZone {min,max} to its midpoint since the rule interface takes a single entry price, not a zone.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 203 | 44 | 27.27% | -0.3193 | -0.4287 | -0.3997 | 8 | 48 | 2.656% | 26 | 16.62 | -0.3974 | -0.46 | fail |
| SOL | 158 | 45 | 40% | -0.0177 | -0.1183 | -0.0875 | 6 | 48 | 3.4% | 23 | 12.95 | -0.4465 | 0.1956 | fail |
| ETH | 191 | 60 | 46.67% | 0.0949 | -0.0329 | 0.0163 | 11 | 48 | 2.952% | 37 | 15.66 | -0.1309 | 0.0651 | fail |
| combined | 552 | 149 | 38.93% | -0.0614 | -0.1756 | -0.1379 | 11 | 48 | 2.96% | 86 | 45.19 | -0.3139 | -0.039 | fail |

## pb-4h-flag-continuation - 4h flag continuation, with 1D trend

Source: docs/MASTER_PLAN_TRADING_MODEL.md M-1, M-5, M-5b, M-6. tf=4h, holdMaxHours=48, stopKind=structure. Runtime: 4428ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 2 | 2 | 0% | -0.5787 | -0.6949 | -0.7447 | 2 | 27.07 | 1.2% | 1 | 0.16 | -1.117 | -0.2729 | fail |
| SOL | 4 | 4 | 50% | -0.2233 | -0.2802 | -0.2664 | 2 | 28.84 | 4.9% | 2 | 0.33 | -0.8283 | 0.268 | fail |
| ETH | 3 | 3 | 66.67% | 0.5794 | 0.4674 | 0.5135 | 1 | 7.82 | 3.311% | 1 | 0.25 | -1.1445 | 1.2733 | fail |
| combined | 9 | 9 | 44.44% | -0.0347 | -0.1232 | -0.1127 | 4 | 9.68 | 3.311% | 4 | 0.74 | -0.7616 | 0.3876 | fail |

## pb-channel-edge-4h - 4h channel edge (with-channel-trend only)

Source: docs/MASTER_PLAN_TRADING_MODEL.md M-3, M-4. tf=4h, holdMaxHours=24, stopKind=atr. Runtime: 4449ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 5 | 5 | 100% | 0.8295 | 0.4152 | 0.5858 | 0 | 24 | 0.843% | 5 | 0.41 | 0.3542 | 0.4559 | pass |
| SOL | 55 | 55 | 36.36% | -0.0878 | -0.6609 | -0.4516 | 14 | 24 | 3.567% | 34 | 4.51 | -0.0916 | -1.2099 | fail |
| ETH | 17 | 17 | 29.41% | -0.0534 | -0.1561 | -0.1179 | 11 | 24 | 3.267% | 13 | 1.39 | -0.5092 | 0.1578 | fail |
| combined | 77 | 77 | 38.96% | -0.0206 | -0.4796 | -0.3106 | 14 | 24 | 3.259% | 52 | 6.3 | 0.0561 | -1.0015 | fail |

## pb-ema21-pullback-1d - 1D-trend EMA21 pullback (4h entry)

Source: docs/MASTER_PLAN_TRADING_MODEL.md M-1, M-6, M-6b, M-9. tf=4h, holdMaxHours=72, stopKind=structure. Runtime: 4410ms.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | median stop % | timeouts | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 7 | 7 | 14.29% | -0.5714 | -0.7801 | -0.7443 | 5 | 9.72 | 1.193% | 0 | 0.57 | -1.1393 | -0.5107 | fail |
| SOL | 13 | 13 | 15.38% | -0.4778 | -0.6564 | -0.6245 | 6 | 15.67 | 1.691% | 1 | 1.07 | -0.4761 | -0.8109 | fail |
| ETH | 14 | 13 | 38.46% | 0.1538 | -0.1104 | -0.0852 | 4 | 13.62 | 1.37% | 0 | 1.15 | -0.8123 | 0.4912 | fail |
| combined | 34 | 33 | 24.24% | -0.2488 | -0.4675 | -0.4375 | 6 | 13.62 | 1.32% | 1 | 2.78 | -0.5448 | -0.3948 | fail |

## Reading (orchestrator, 2026-09-26, after the scoring patch)

Scoring fixes applied before this reading: signals outside the 1-minute fixture coverage (2026-07-01 → 2026-09-24, 85.5 days) are excluded from n; a trade still open at its hold limit is closed at that candle's close and scored mark-to-market (`timeout`, counted as resolved) instead of being dropped; a median stop-distance column was added. The seeded random rule now reads +0.13R gross / −2.09R net at a 0.83 % median stop, which is the right sanity result: random entries earn nothing before costs and lose roughly cost ÷ stop after them, so the scorer is not inventing edge.

**No rule shows a usable swing edge on this window.** Eight of nine are net-negative and fail the two-half split. The one pass, `ctl-donchian-20d` (+0.16R net, 71 % wins), rests on 7 resolved trades, all closed at the 72 h limit with a 19 % median stop; that is a sample, not a strategy. The two rules with real signal counts, `legacy-trend4h` (149 resolved) and `ctl-4h-range-break` (119), are flat-to-negative gross (−0.06R / +0.04R) before costs, so wider stops cannot rescue them. `legacy-swing` produced zero signals, and in production it can never fire: `services/scalpContext.js` never requests the 3d timeframe its gate needs, so SWING has been dead code since the timeframe list was set. The playbook rules are net-negative on 9–77 signals; the 1D-trend EMA21 pullback (33 resolved, 24 % wins) is the most tested of them and the clearest loser.

What this does say: at 4h/1d timeframes fees stop being the story (stops 1.3–5 %, cost ≤ 0.25R), so a rule with real gross edge would show it; none of these has one over July–September 2026, a window that was mostly range-bound for BTC/SOL/ETH. Next steps worth the time, in order: (1) capture a longer 1m history (the 4h/1d files already reach back to 2024; the 1m backfill is the limit) and re-run the same nine rules, since 85 days is too short for 1d rules to produce even 30 trades; (2) fix or retire SWING in production (either request 3d or delete the strategy); (3) do not build S1/S2 on any of these rules yet.
