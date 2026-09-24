# Flag paths — measured base rates (T4 P0)

**Status: PROVISIONAL.** Measured on development data only (`scripts/replay-paths.js`, `scripts/tracker/flag-paths.js`); no production file reads it. Definitions: `docs/PLAN_FLAG_PATHS.md`. Nothing here changes a threshold; the tracker's testing window is frozen.

Last updated: 2026-09-24.

## Data

| Dataset | Span | Builds | Flags labelled |
| --- | --- | --- | --- |
| `test/fixtures/history/deep-2026-09-24/` (Kraken trades backfill, `scripts/replay.js --capture --backfill-1m 20880`) | 2026-09-09 → 2026-09-24, about 15 days, BTC/SOL/ETH, 0 missing 1m minutes | 55,701 (6.3 ms/build) | **10,997** (BTC 3,716, SOL 3,571, ETH 3,710) |
| `2026-09-22` + `2026-09-23` short captures | 2 × ~12–18 h | 716 | 380 (early check; same shape) |

Each flag is labelled once, from its first tightening point (first close where it is `forming` or `proto`), through the production pipeline with no lookahead.

A labeller bug was fixed before these numbers: the breakout candle's own 1m candles had been counted as a retest, so runners almost never appeared (an earlier draft showed runner 0.3%). A retest now only counts after the breakout candle has closed (regression test in `test-flag-paths.js`).

## Headline

| path | share (n=10,997) |
| --- | --- |
| fail_first — invalidation close before any breakout | **47.9%** |
| retest_go — breakout, retest-hold, +1R | 16.1% |
| runner — breakout, +1R with no retest | 15.3% |
| false_break — breakout, back inside, invalidation | 12.0% |
| chop — unresolved in 24 candles | 8.8% |

1. **About half of all tightening flags fail before they break out.** This is stable across symbols (BTC 47.7%, SOL 47.9%, ETH 48.1%), timeframes (1m 48.4 / 3m 47.1 / 5m 47.0) and direction (long 48.7 / short 47.1). A flag at the moment it tightens is close to a coin flip on whether it breaks out at all.
2. **Of the 5,558 flags that break out, runners are as common as clean retests:** retest_go 31.8%, runner 30.2%, false_break 23.7%, chop 14.3%. Waiting for the retest catches only about half of the breakouts that work. The SOL 2026-09-24 case is the normal pattern, not an exception.
3. **Runners are bigger and faster:** median max favourable excursion 3.1R, resolving about 2 min after tightening, versus 2.1R and about 10 min for retest_go.

## What moves the odds (all buckets n ≥ 100; single 15-day window)

Fewer failures before breakout (fail_first, baseline 47.9%):

| Feature | Better | Worse |
| --- | --- | --- |
| structure inside the flag (`structureSteps`: higher lows long / lower highs short) | many 34.7% (but chop 31.1%), some 43.9% | none 58.1% |
| impulse into the flag (`impulseStrength`) | moderate 43.4% | strong 50.3% |
| level tests (`levelTests`) | one 45.6% | none 52.8% |
| flag duration | long 41.8% (chop 29.3%) | short 49.2% |
| cross-timeframe agreement (`tfAgreement`) | disagree 43.9% | agree 49.8% (counter-intuitive; investigate) |

Runner vs retest (who breaks out without giving an entry; runner baseline 15.3%):

| Feature | More runners | Fewer runners |
| --- | --- | --- |
| room to the next opposing level (`roomR`) | roomy 23.0% | tight 9.3% (chop 16.2%) |
| compression | tight 21.0% | moderate 11.8% |
| impulse | moderate 20.0% | strong 12.8% |
| level tests | one 18.1% | none 9.8% |
| timeframe | 1m 17.2% | 5m 9.0% |
| Stoch RSI side | overbought 18.8% / oversold 17.8% | bullish 13.7% / bearish 14.0% |

No meaningful effect at this n: direction, `ema200Side`, Stoch slope, hour of day.

Not measurable yet: `tdSide` was `bull` on every row. The top-down vote is weighted towards the 1w/1d leans, and those did not flip in this window. A window that includes a bear or mixed regime is needed before top-down can be measured.

## What this means for the plan

- **Direction at tightening is not where the edge is:** fail_first barely moves with direction, EMA200 side or Stoch slope. The strongest single filter is structure inside the flag (higher lows long / lower highs short), which cuts fail_first from 58% to 35–44%.
- **Chase risk is predictable:** roomy targets, tight compression, a tested level and 1m flags raise the runner share to about 20–23%. Those are the flags where "wait for the retest" most often means no entry, which is what the P1 `pathOutlook.chaseRisk` field should say.
- **P4 has a case to test but not to adopt:** runners are about 30% of breakouts with a 3.1R median excursion. A breakout-close entry is worth replay-testing with fees, stops and the 3R rule before any decision.

## The SOL 2026-09-24 case (in the data)

The 5m long tightened at **04:35Z** as `proto`: breakout 114.93, invalidation 114.71. It is labelled **runner**, with a max favourable excursion of 5.3R (it later went on beyond the $115.42 seen in chat). Its features at tightening:
- compression tight
- impulse moderate
- level tested once
- `tfAgreement` agree
- below the EMA200
- room moderate

Three of those (tight compression, moderate impulse, one level test) are the buckets that raise the runner share to about 18–21%, against a 15.3% baseline. A measured `pathOutlook` would have flagged elevated chase risk at 04:35, before the 04:51 message.

Same move on other timeframes: a 1m long (04:40Z, breakout 114.92) and a 3m long (04:42Z) are both labelled retest_go, meaning a retest-hold did occur on those finer timeframes before +1R of *their* (smaller) R.

## Caveats

- 10,997 flags are not 10,997 independent trials: one 15-day window, one top-down regime, three correlated symbols.
- `retestTolR` 0.15R stands in for the engine's ATR-based retest tolerance, so retest_go shares are not directly comparable to `flagTradePlan`'s ready rate.
- `roomR` uses `scripts/replay-paths.js`'s own nearest-opposing-zone function, not `lib/flagTradePlan.js`'s private TP1 cap.
- Kraken candles, not TradingView's SOLUSDT; small price differences.
- Flags in the last ~2 h of the window have an incomplete 24-candle window and lean `chop` (under 2% of rows).

## Reproduce

```
node scripts/replay.js --capture BTC,SOL,ETH --out test/fixtures/history/deep-<date>/ --backfill-1m 20880   # ~65 min, resumable
for s in BTC SOL ETH; do node scripts/replay-paths.js --history test/fixtures/history/deep-<date> --symbols $s --out deep-$s.jsonl & done; wait   # ~2 min each
cat deep-*.jsonl > deep-all.jsonl && node scripts/replay-paths.js --in deep-all.jsonl --report --json deep-all.report.json
```
