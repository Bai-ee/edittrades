# S0 swing-trade research - study results

Generated 2026-09-27T02:05:35.541Z by `scripts/swing/run.js` (Agent S0-A harness), fixture `test/fixtures/history/deep60-2026-09-24`.

Columns: n (signals generated) · resolved (walked to a win/loss) · win % · gross exp R · net exp R (0.34% long / 0.14% short direction cost) · 0.20% sensitivity net R · max losing streak (resolved trades) · median hold (hours) · signals/week · OOS first/second half net R (dir-cost) · pass/fail (net > 0 in both halves).

## legacy-swing - Legacy SWING (services/strategy.js)

Source: services/strategy.js evaluateAllStrategies -> evaluateSwingSetup (spec §1). tf=4h, holdMaxHours=72, stopKind=structure. Runtime: 7746ms.

- Calls the real evaluator (evaluateAllStrategies) with marketData/dflowData nulled - both only adjust confidence/volume gates, guarded by truthy checks in services/strategy.js, so null is a safe no-op.
- Production never supplies a 3D timeframe (services/scalpContext.js requests 1m/3m/5m/15m/1h/4h/1d only), so SWING is dead code live regardless of market conditions; this rule synthesizes 3D from 1D with the codebase's own (unused) bucketing (services/marketData.js aggregate3DayCandles) over the full available 1D history, so bucket edges stay stable across the replay instead of rolling with a fixed-window fetch.
- entry/stop/tp1/tp2 collapse the evaluator's entryZone {min,max} to its midpoint since the rule interface takes a single entry price, not a zone.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 0 | 0 | - | - | - | - | 0 | - | 0 | - | - | fail |
| SOL | 0 | 0 | - | - | - | - | 0 | - | 0 | - | - | fail |
| ETH | 0 | 0 | - | - | - | - | 0 | - | 0 | - | - | fail |
| combined | 0 | 0 | - | - | - | - | 0 | - | 0 | - | - | fail |

## legacy-trend4h - Legacy TREND_4H (services/strategy.js)

Source: services/strategy.js evaluateAllStrategies -> evaluateStrategy(setupType='4h') (spec §2). tf=4h, holdMaxHours=48, stopKind=structure. Runtime: 7076ms.

- Calls the real evaluator (evaluateAllStrategies) with marketData/dflowData nulled - both only adjust confidence/volume gates, guarded by truthy checks in services/strategy.js, so null is a safe no-op.
- No missing-timeframe gap: TREND_4H's evaluator path only reads 4h/1h/15m/5m, all of which production supplies live, so this rule scores production behavior exactly, no synthesized inputs.
- entry/stop/tp1/tp2 collapse the evaluator's entryZone {min,max} to its midpoint since the rule interface takes a single entry price, not a zone.

| scope | n | resolved | win % | gross exp R | net exp R (dir-cost) | 0.20% sens | max losing streak | median hold h | signals/week | OOS 1st half net R | OOS 2nd half net R | pass/fail |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BTC | 206 | 18 | 0% | -1 | -1.155 | -1.1086 | 18 | 14.06 | 16.7 | -1.1483 | -1.1618 | fail |
| SOL | 160 | 22 | 18.18% | -0.272 | -0.3898 | -0.3486 | 11 | 24.23 | 12.97 | -1.1151 | 0.3354 | fail |
| ETH | 193 | 23 | 13.04% | -0.4782 | -0.6205 | -0.5683 | 11 | 25.12 | 15.65 | -0.4223 | -0.8023 | fail |
| combined | 559 | 63 | 11.11% | -0.5553 | -0.6927 | -0.646 | 29 | 18.77 | 45.32 | -0.8798 | -0.5114 | fail |
