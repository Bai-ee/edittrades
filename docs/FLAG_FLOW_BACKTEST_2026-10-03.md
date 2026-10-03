# Flag-flow backtest, 200 days (2026-03-10 to 2026-09-26)

Purpose: real evidence for the tracker's 70% tuning table. Replays the live flag-flow alert logic over stored candle history and scores every LOCK OPPORTUNITY it would have sent with the tracker's called-flag rule. Script: `scripts/replay-flag-flow.js`. Test: `npm run test:replayflow`.

Outputs (scratchpad, not in the repo): `/private/tmp/claude-501/-Users-bballi-Documents-Repos-snapshot-tradingview/b92aaf28-ec37-41a1-9431-47cde5faf786/scratchpad/backtest/` with `outcomes-min5.jsonl`, `outcomes-min1.jsonl`, `calibration-min5.json`, `calibration-min1.json`, `summary.json`, `run-stats.json`.

## Trade payoff (TP vs SL, net of fees)

Question: a ~50% direction hit rate can still pay if winners are bigger than losers. This measures the actual trade. Script `scripts/replay-payoff.js` (test `npm run test:replaypayoff`) over the alert-price runs (`outcomes-min5-alertpx.jsonl`, `outcomes-min1-alertpx.jsonl`); results in `payoff-min5.json` and `payoff-min1.json` in the scratchpad backtest dir.

Rules: entry = alert price (open of the 1m candle right after the alert), stop = the card's SL (flag invalidation), target = the card's TP (measured move). Walk 1m candles: stop first = loss, target first = win, one candle touching both = loss, no time limit (a trade open at the end of data is reported as unresolved and left out). R = (exit - entry) / (entry - stop) in the trade direction, so a win is reward/risk measured from the alert price and a loss is -1R. Net R subtracts the round-trip cost in R: `risk.costBpsByDirection` (long 34 bps, short 14 bps) x alert price / stop distance (the conversion `scripts/tracker/costs.js` uses). Variant A = card target. Variant B = card target, half off at +1R then stop to breakeven (a candle that touches +1R and entry together exits the rest at breakeven; "win" there is any trade with positive gross R, so breakeven-after-half counts as a +0.5R win). Variant C = target at 2R from the alert price. Alerts whose alert price is already past the target or stop are skipped (counts below).

| Run | Var | n | Win rate | Avg win R | Avg loss R | Gross R/trade | Net R/trade | Total net R | Median min | Max DD R | Unresolved / skipped |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| min5 | A | 9,739 | 36.3% | 1.78 | -1 | +0.008 | -1.546 | -15,054 | 27 | 15,054 | 5 / 1 |
| min5 | B | 9,741 | 50.0% | 0.96 | -1 | -0.021 | -1.574 | -15,337 | 23 | 15,337 | 3 / 1 |
| min5 | C | 9,739 | 33.7% | 2 | -1 | +0.010 | -1.544 | -15,041 | 31 | 15,041 | 5 / 1 |
| min1 | A | 29,147 | 34.4% | 1.85 | -1 | -0.018 | -2.776 | -80,906 | 21 | 80,906 | 8 / 4 |
| min1 | B | 29,150 | 49.3% | 0.94 | -1 | -0.045 | -2.802 | -81,682 | 18 | 81,682 | 5 / 4 |
| min1 | C | 29,147 | 32.6% | 2 | -1 | -0.021 | -2.778 | -80,968 | 23 | 80,970 | 8 / 4 |

Headline: gross expectancy is about zero in every variant (min5 A +0.008R, min1 A -0.018R): the card's measured-move target is hit about 36% of the time at an average +1.78R, which is a fair game before costs. Net of fees it loses 1.55R per trade on min5 and 2.78R on min1, because the fee is 1.55R on average (min5) and 2.76R (min1): the stops are tight against a 34 / 14 bps round trip. Max drawdown equals the total loss because the equity curve falls almost monotonically.

By timeframe (cells: n, win rate, gross R, net R per trade):

| timeframe | min5 A | min5 B | min5 C | min1 A | min1 B | min1 C |
| --- | --- | --- | --- | --- | --- | --- |
| 15m | 731, 40%, +0.07, -0.30 | 731, 52%, +0.05, -0.32 | 731, 38%, +0.15, -0.22 | 1,212, 38%, +0.06, -0.35 | 1,212, 53%, +0.05, -0.36 | 1,212, 36%, +0.08, -0.33 |
| 1h | 270, 37%, -0.00, -0.17 | 271, 49%, -0.01, -0.18 | 269, 31%, -0.06, -0.23 | 309, 36%, -0.02, -0.20 | 309, 50%, -0.02, -0.21 | 308, 32%, -0.03, -0.21 |
| 1m | 4,306, 35%, +0.02, -2.57 | 4,306, 50%, -0.04, -2.62 | 4,306, 33%, -0.01, -2.59 | 16,537, 34%, -0.01, -4.16 | 16,538, 49%, -0.06, -4.21 | 16,538, 32%, -0.02, -4.18 |
| 3m | 2,560, 36%, -0.01, -0.97 | 2,560, 50%, -0.03, -0.98 | 2,560, 33%, +0.00, -0.95 | 6,958, 34%, -0.04, -1.18 | 6,958, 49%, -0.04, -1.17 | 6,957, 32%, -0.03, -1.17 |
| 4h | 70, 34%, -0.12, -0.19 | 71, 48%, -0.08, -0.16 | 71, 30%, -0.11, -0.19 | 72, 35%, -0.10, -0.18 | 73, 49%, -0.08, -0.16 | 73, 32%, -0.06, -0.13 |
| 5m | 1,802, 38%, +0.00, -0.69 | 1,802, 50%, -0.01, -0.69 | 1,802, 34%, +0.02, -0.67 | 4,059, 36%, -0.03, -0.83 | 4,060, 49%, -0.03, -0.83 | 4,059, 33%, -0.01, -0.81 |

By score (cells: n, win rate, gross R, net R per trade):

| score | min5 A | min5 B | min5 C | min1 A | min1 B | min1 C |
| --- | --- | --- | --- | --- | --- | --- |
| 1/7 | - | - | - | 4,150, 31%, -0.07, -3.05 | 4,151, 47%, -0.09, -3.07 | 4,151, 31%, -0.08, -3.06 |
| 2/7 | - | - | - | 5,062, 34%, -0.01, -1.89 | 5,062, 50%, -0.03, -1.91 | 5,061, 33%, -0.01, -1.89 |
| 3/7 | 2, 0%, -1.00, -2.05 | 2, 0%, -1.00, -2.05 | 2, 0%, -1.00, -2.05 | 6,454, 34%, -0.03, -5.14 | 6,455, 49%, -0.05, -5.16 | 6,455, 32%, -0.04, -5.15 |
| 4/7 | 9, 33%, +0.06, -1.60 | 9, 33%, -0.14, -1.79 | 9, 22%, -0.33, -1.99 | 5,738, 35%, -0.01, -2.50 | 5,738, 49%, -0.05, -2.53 | 5,738, 33%, -0.02, -2.50 |
| 5/7 | 6,450, 37%, +0.02, -1.67 | 6,452, 50%, -0.02, -1.70 | 6,450, 33%, +0.00, -1.68 | 4,544, 36%, +0.01, -1.54 | 4,545, 50%, -0.02, -1.58 | 4,543, 33%, -0.00, -1.56 |
| 6/7 | 2,630, 35%, -0.03, -1.41 | 2,630, 49%, -0.04, -1.42 | 2,630, 33%, +0.00, -1.38 | 2,550, 35%, -0.02, -1.42 | 2,550, 49%, -0.03, -1.43 | 2,550, 34%, +0.01, -1.38 |
| 7/7 | 648, 39%, +0.09, -0.85 | 648, 53%, +0.05, -0.89 | 648, 38%, +0.13, -0.81 | 649, 39%, +0.09, -0.85 | 649, 53%, +0.04, -0.90 | 649, 38%, +0.13, -0.81 |

By R:R at alert (cells: n, win rate, gross R, net R per trade):

| R:R at alert | min5 A | min5 B | min5 C | min1 A | min1 B | min1 C |
| --- | --- | --- | --- | --- | --- | --- |
| 1-2R | 4,864, 40%, -0.01, -1.02 | 4,865, 49%, -0.02, -1.03 | 4,864, 34%, +0.01, -1.00 | 13,719, 39%, -0.03, -1.34 | 13,719, 48%, -0.05, -1.36 | 13,718, 32%, -0.03, -1.34 |
| 2R+ | 3,945, 27%, +0.03, -2.36 | 3,946, 49%, -0.03, -2.42 | 3,946, 34%, +0.02, -2.38 | 12,875, 25%, -0.01, -4.63 | 12,878, 48%, -0.06, -4.67 | 12,877, 32%, -0.03, -4.64 |
| <1R | 930, 57%, +0.01, -0.83 | 930, 57%, +0.01, -0.83 | 929, 33%, -0.00, -0.85 | 2,553, 58%, +0.01, -1.13 | 2,553, 58%, +0.01, -1.13 | 2,552, 35%, +0.04, -1.11 |

By half (cells: n, win rate, gross R, net R per trade):

| half | min5 A | min5 B | min5 C | min1 A | min1 B | min1 C |
| --- | --- | --- | --- | --- | --- | --- |
| first100d | 4,937, 37%, +0.03, -1.44 | 4,937, 51%, -0.01, -1.47 | 4,937, 34%, +0.04, -1.43 | 14,582, 34%, -0.03, -1.55 | 14,582, 49%, -0.05, -1.57 | 14,582, 33%, -0.02, -1.54 |
| last100d | 4,802, 35%, -0.01, -1.66 | 4,804, 49%, -0.03, -1.68 | 4,802, 33%, -0.02, -1.67 | 14,565, 34%, -0.01, -4.01 | 14,568, 49%, -0.04, -4.04 | 14,565, 33%, -0.02, -4.02 |

Reading the splits: gross expectancy is within about +/-0.1R in every slice with a meaningful n. Net R improves with timeframe (the stop is wider relative to the fee: 1m about -2.6R, 15m about -0.3R, 1h about -0.2R, 4h about -0.2R per trade on min5 variant A), but stays negative everywhere. The best net slices are the <1R and 1-2R buckets (smaller reward, wider stop relative to price) and 7/7, still negative.

Caveats:
- 1m data is Binance (per the history manifest), so fills and wicks are not Kraken's.
- Overlapping 1m, 3m and 5m calls in the same move are separate trades here, not independent; total R and drawdown add them as if each could be taken. n overstates independent events.
- Costs are the engine's fixed round-trip bps. Slippage is not modelled beyond them, nor are spread widening in fast moves, partial fills, or funding.
- A 1m candle touching both stop and target counts as a loss; stops are assumed filled at the stop level (no gap through it).
- Trades with no time limit are walked to the end of data; unresolved and skipped counts are in the table (a handful).
- Result is one 200-day window and one price regime (see Caveats below); it says nothing about a different stop/target design.

## Scoring from the alert price (current)

Change (owner request): `scoreCalledFlag` now anchors at the price when the alert was sent, the open of the first 1m candle at/after `calledAt` (else the last 1m close before it). RIGHT = +1 ATR (flag timeframe, at alert time) from that anchor in the called direction before -1 ATR; WRONG = reverse (a candle touching both counts wrong); FLAT = neither within 12 flag-timeframe candles. Rows add `anchor` and `entryOffsetAtr` (signed (anchor - entry) / ATR in the trade direction); `entry` is unchanged. In this backtest the alert price is the open of the 1m candle right after the evaluation close (no lookahead). Same alerts, same 9,745 / 29,159 rows as below, only the outcome changed. Files carry the suffix `-alertpx` in the scratchpad backtest dir (`outcomes-min5-alertpx.jsonl`, `outcomes-min1-alertpx.jsonl`, `calibration-*-alertpx.json`, `summary-alertpx.json`). Existing tracker rows already scored under the old rule are kept as they were (final outcomes are idempotent).

Overall:

| Run | Alerts | right | wrong | flat | Hit rate |
| --- | --- | --- | --- | --- | --- |
| min5 | 9,745 | 4,816 | 4,857 | 72 | 49.8% |
| min1 | 29,159 | 14,101 | 14,822 | 236 | 48.8% |

For reference, a symmetric random walk scores about 50% on a 1 ATR vs -1 ATR race. Neither run is distinguishable from that on this rule.

By score (min5 / min1; rate, alerts): 5/7 49.7% (6,455) / 49.5% (4,546); 6/7 49.2% (2,631) / 49.1% (2,551); 7/7 53.2% (648) / 53.1% (649). min1 also 1/7 47.3%, 2/7 49.1%, 3/7 48.6%, 4/7 48.4%.

By timeframe (min5 / min1): 1m 49.0% / 48.2%; 3m 49.7% / 48.8%; 5m 50.5% / 50.3%; 15m 50.8% / 50.1%; 1h 53.8% (272) / 52.8% (310); 4h 57.1% (73) / 58.3% (75).

By R:R (min5 / min1): <1R 46.7% (15) / 58.3% (48); 1-2R 51.5% / 49.8%; 2R+ 49.2% / 48.4%.

By next timeframe (min5 / min1): agrees 49.6% / 48.7%; mixed 50.9% / 48.8%; disagrees 3 alerts / 50.7% (68).

By symbol (min5 / min1): BTC 49.0% / 48.3%; ETH 50.3% / 48.4%; SOL 50.1% / 49.5%. By direction: long 49.3% / 48.7%; short 50.3% / 48.8%.

Entry-offset bands at the alert (price vs entry in the called direction, ATR of the flag timeframe; min5 alerts / rate, min1 alerts / rate):

| Band | min5 | min1 |
| --- | --- | --- |
| below entry | 1,640 / 52.8% | 5,736 / 50.3% |
| 0 to 0.25 ATR | 1,820 / 47.6% | 5,465 / 47.9% |
| 0.25 to 0.5 | 1,799 / 49.3% | 5,135 / 47.6% |
| 0.5 to 1 | 2,619 / 49.6% | 7,616 / 48.7% |
| 1 to 1.5 | 1,800 / 50.2% | 4,999 / 49.2% |
| 1.5+ | 67 / 44.8% | 208 / 48.6% |

Optimizer (target 70, minN 30, whole window): no rule meets 70% in either run. Both runs return the same best rule, "7/7+ on 15m-4h with R:R >= 2": 59% over 41 decided calls (24 right, 17 wrong), status `below`. Next: 7/7+ with R:R >= 2 on 5m-4h, 57% over 128; 7/7+ with any R:R on 15m-4h, 56% over 64. Single-bucket tables (min5): no bucket meets 70%; best are 4h 57% (70 decided, thin) and 7/7 53% (645).

What a tighter no-chase cap would buy (min5 alert-price run, alerts sent only when the alert price is within X ATR of entry, offset <= X, which includes price still below entry; the `abs` column also drops alerts more than X below entry):

| X (ATR) | Alerts kept | Hit rate | Alerts kept (abs) | Hit rate (abs) |
| --- | --- | --- | --- | --- |
| 0.25 | 3,474 | 50.1% | 2,545 | 49.4% |
| 0.5 | 5,266 | 49.8% | 4,819 | 49.3% |
| 1.0 | 7,894 | 49.7% | 7,837 | 49.6% |
| 1.5 (current cap) | 9,683 | 49.8% | 9,676 | 49.8% |

Tightening the cap cuts the number of alerts and does not move the hit rate (all within 49.3% to 50.1%). The same sweep on min1 is in `summary-alertpx.json` (`capSweep`), also about 48.5% to 49.1%.

Reading: the earlier 68.6% was a product of anchoring at the entry level while price had already moved past it (see the superseded section). Judged from what a user could actually get, the rule hit about 50% in this window for every score, timeframe, R:R, next-timeframe, symbol and offset slice, with the thin 1h/4h/7-of-7 buckets (n 73 to 650) a few points above 50%. Fees are still not in the rule. The stop is a median 2.1 ATR away while the rule uses 1 ATR, so this is a scoring-rule result, not a P&L result.

## Superseded: entry-anchored results

Superseded: these scored from the entry (breakout) level, not the alert price. Alerts fire after the break, so a median 0.44 ATR (p90 1.22 ATR) of the 1 ATR was already earned and the hit rate rose with the offset (table in Caveats). Kept for comparison only. Files: `outcomes-min5.jsonl`, `outcomes-min1.jsonl`, `calibration-min5.json`, `calibration-min1.json`, `summary.json`.

## Method

Reused, not re-implemented:
- Candidates: `detectFlagLifecycle` (both directions) on 1m, 3m, 5m, 15m, 1h, 4h (`ENGINE_CONFIG.model.flagTimeframes`), `identifyCandidate`, `snapCandidateLevels` with the geometry the live build makes (`buildGeometryContext` + `buildGeometryB` with `buildStructure` levels), `measuredMoveFor`. Board rows use the same shape as `buildFlagBoardEntries`.
- Alert and score: the real `diffFlow` (-> `rankFlags` -> `scoreFlag` -> `confluenceChecklist`) fed a payload with all seven timeframe entries (1m to 1d). One LOCK OPPORTUNITY per candidateId, max one per symbol+timeframe per 15 min, stage `lockable` as live.
- Outcome: `calledFlagsFromAlerts` + `scoreCalledFlags` (1x ATR(14) of the flag timeframe our way before 1x against, within 12 candles, 1m candles, measured from the entry level in the first run, from the alert price in the current one, see the first section). Rows carry `flow {score, of, rr, nextTf}` as the live alert log does. `calibrateCalledFlags` (target 70, minN 30) ran over the whole window (one added optional arg `windowDays`, default 30, in `scripts/tracker/called-flags.js`).
- Two runs over identical candidates: `min5` (`minScore` 5/7, the live rule) and `min1` (`minScore` 1/7: the pre-5/7 behaviour; the checklist gate on the flag's own timeframe still applies in both).

No lookahead: at time t only candles with closeTime <= t are read, windows are the live 499 closed candles per timeframe, indicators (EMA21, EMA200, Stoch RSI) are the same library calls over that window. Test proof: corrupting every candle after a cut changes nothing at or before the cut.

Fidelity check (ad hoc, not in the test): at 40 sampled closes of 2026-09-23 the real `buildScalpContext` replay (`scripts/replay.js` fetch, `includeFlagBoard`) and this script agreed on every triggering/confirmed candidate: 71 of 71 matched on id, state, breakout, invalidation, target and R:R, none missing, none extra.

Approximated:
- Each flag timeframe is re-detected at that timeframe's closes; between closes the candidate is frozen and the checklist and price are re-evaluated at every 1m close (the live cron does the same).
- Price = close of the newest closed 1m candle (live uses the mark price).
- 3m is bucketed from 1m (as production). The 1d file ends 2026-09-25 00:00; the last day or two is bucketed from 1m.
- Only triggering/confirmed candidates are evaluated (only those can be `lockable`); FOUND/BREAKING are not pushed live and are not counted.
- Sampling: none. Every close of every timeframe, every symbol, all 200 days. Runtime 10.7 min.

## Data

`test/fixtures/history/deep2y-2026-09-26` (main repo). Manifest: 1m is Binance, 5m to 4h bucketed from 1m, 1d Kraken. Evaluated closes 2026-03-10T00:00Z to 2026-09-26T00:00Z (200 days). All 1m data runs to 2026-09-27 03:06Z, so every alert's 12-candle window finished (0 open, 0 no_data).

### Entry-anchored counts and hit rate

Hit rate = right / (right + wrong); flat is excluded (as live). Overall:

| Run | Alerts | right | wrong | flat | Hit rate | Alerts/day (3 symbols) |
| --- | --- | --- | --- | --- | --- | --- |
| min5 | 9,745 | 6,645 | 3,036 | 64 | 68.6% | 48.7 |
| min1 | 29,159 | 19,001 | 9,970 | 188 | 65.6% | 145.8 |

Stability: min5 69.2% (first 100 days, n 4,909) vs 68.1% (last 100 days, n 4,772); min1 65.6% vs 65.5%.

By timeframe (alerts / hit rate):

| TF | min5 | min1 |
| --- | --- | --- |
| 1m | 4,307 / 69.3% | 16,541 / 67.1% |
| 3m | 2,560 / 68.1% | 6,960 / 63.8% |
| 5m | 1,802 / 68.1% | 4,061 / 63.4% |
| 15m | 731 / 67.3% | 1,212 / 62.1% |
| 1h | 272 / 71.6% | 310 / 68.9% |
| 4h | 73 / 66.7% | 75 / 64.9% |

By symbol: min5 BTC 3,207 / 68.2%, ETH 3,185 / 68.7%, SOL 3,353 / 69.1%; min1 BTC 9,756 / 65.0%, ETH 9,600 / 65.1%, SOL 9,803 / 66.6%. Per symbol and timeframe: `summary.json` (`bySymbolTimeframe`). By direction: min5 long 4,945 / 68.9%, short 4,800 / 68.4%; min1 long 14,687 / 65.9%, short 14,472 / 65.2%.

By score (flow.score of 7; min5 rows below 5 are 4/6-type stacks where a timeframe had no mark, since the rule is a ratio):

| Score | min5 | min1 |
| --- | --- | --- |
| 1/7 | | 4,152 / 64.2% |
| 2/7 | | 5,064 / 64.1% |
| 3/7 | 2 / 100% | 6,458 / 65.1% |
| 4/7 | 9 / 55.6% | 5,739 / 65.3% |
| 5/7 | 6,455 / 68.2% | 4,546 / 67.0% |
| 6/7 | 2,631 / 69.0% | 2,551 / 68.7% |
| 7/7 | 648 / 71.4% | 649 / 71.4% |

By R:R: <1R min5 15 / 40.0%, min1 48 / 47.9%; 1-2R min5 2,592 / 62.5%, min1 7,471 / 59.4%; 2R+ min5 7,138 / 70.9%, min1 21,640 / 67.8%.

By next timeframe: agrees min5 8,321 / 68.5%, min1 17,178 / 65.4%; mixed min5 1,421 / 69.5%, min1 11,913 / 65.9%; disagrees min5 3 / 100%, min1 68 / 61.8%.

### Entry-anchored optimizer recommendation (`calibrateCalledFlags`, target 70, minN 30, whole window)

- min5 run: "5/7+ on 1m-4h with R:R >= 2": 71% over 7,084 decided calls (5,026 right, 2,058 wrong). Next best: same plus next timeframe agreeing, 71% n 6,121; 3m-4h only, 71% n 3,498.
- min1 run: the same rule, 70% over 5,730 calls (4,033 / 1,697).
- Calibration scored 9,681 (min5) and 28,971 (min1) decided calls. Only the 7/7, 1h and 2R+ single-bucket tables meet 70% in the min5 run; score 5/7 and 6/7 are 68 and 69%.

### Caveats (entry-anchored run; the offset table is the reason it was superseded, the rest still applies)

- Fees and slippage are not in the hit rule. A 1 ATR win and a 1 ATR loss are scored equally here; the stop distance is a median 2.1 ATR (the rule does not use the real stop or TP).
- The rule anchors at the entry (breakout) level, not at the alert price. Alerts fire after the break, with price up to the 1.5 ATR no-chase cap past entry. Hit rate by alert price vs entry (in the called direction, ATR of the flag timeframe, min5 run):

| Price vs entry at alert | Alerts | Hit rate |
| --- | --- | --- |
| below entry | 1,631 | 34.9% |
| 0 to 0.25 ATR past | 1,805 | 53.3% |
| 0.25 to 0.5 ATR | 1,771 | 65.4% |
| 0.5 to 1 ATR | 2,618 | 81.5% |
| 1 ATR or more | 1,856 | 98.1% |

  Median offset is 0.44 ATR (p90 1.22 ATR). The pre-earned distance explains most of the 68.6%; alerts close to the entry level are near coin-flip. min1 shows the same pattern (31.6%, 53.2%, 63.7%, 79.3%, 97.6%). This is how the live tracker scores too, so the backtest matches it, but the 70% target is measured against that anchoring. (This split was computed ad hoc from the outcome rows and the 1m open at the alert minute; it is not in `summary.json`.)
- Regime: the window is not flat. BTC 68.4k (Mar 10) -> 64.5k (Jun 18) -> 84.1k (Sep 25); ETH 1,993 -> 1,751 -> 2,691; SOL 84.95 -> 72.05 -> 122.02. Both halves give similar rates, but it is one regime sequence.
- Overlap: 1m, 3m and 5m flags in the same move are separate candidateIds and count as separate calls, so n overstates independent events (about 16 alerts per symbol per day in min5).
- Rows are 1m-resolution: a 1m candle touching both bands counts wrong, as live.
- Small buckets: 4h (73 / 75 alerts), 1h (272), and R:R <1 (15) are thin or near minN; the "disagrees" next-timeframe bucket has 3 alerts in min5.
- The backtest sees one price per minute and no mark price; live alerts depend on cron timing and Telegram dedupe state (open locks) that cannot be replayed.
- Not a recommendation. These are the numbers the optimizer returned and the splits above.
