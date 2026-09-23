# Flag Recommendation Review Sheet

Created: 2026-09-23  
Scope: schema 1.14.0 local implementation; R:R samples updated for schema 1.17.0 (owner-approved 2026-09-23: 3R is gross price R, net R is information); samples regenerated for schema 1.18.0 (Phase 2, recommendation completeness: context codes on every record, `candidate` on a no-plan WATCH, concrete `changeConditions`). These examples are deterministic fixtures for communication fidelity (`test-flag-recommendation-fixtures.js`, pinned clock). They are not profitability evidence.

## Representative Outputs

Generated from the fixture builders in `test-flag-recommendation-fixtures.js` (schema 1.18.0). Each block shows the default-payload `flagRecommendation` codes, then how the GPT renders them. Full per-reason text and refs are under `model.recommendation` (`include=model`).

### Context codes (every record except `market_data_unavailable`)

Placed as support / oppose for the plan's or named candidate's direction, or as unknown when there is no direction. None of them ever changes the class.

| Code | Meaning |
| --- | --- |
| `td:<sentiment>:<n>/4` | Top-down sentiment and how many of 1W/1D/4H/1H agree |
| `a200:<above>/<of>` | Timeframes with price above EMA200 |
| `ema200:<tf>:<side>` | The candidate's own timeframe vs EMA200 |
| `ema200:1w:missing` | Weekly EMA200 not computable (never guessed) |
| `4h:with` / `ct:4h` / `4h:flat` | 4h lean vs the direction |
| `level:<geomTf>:<price>` / `level:none` | First level beyond the breakout on the candidate's own geometry timeframe; oppose when it sits before the measured target |
| `tp1_capped:<price>` | TP1 capped by an earlier level before the measured move |
| `chan:<geomTf>:<edge>:<risk>` | Channel-edge breakout risk (oppose on a fade) |
| `conflict:` / `stoch:` / `rr:` | The candidate's own `qual.reasons` |
| `divergence_agrees` / `divergence_conflicts` / `divergence_absent` / `divergence_undirected` | Stoch RSI divergence |
| `data_fresh` / `data_partial` | Flag-timeframe freshness |

### GOOD

```json
{"class":"GOOD","candidateId":"BTC:1m:long:2026-09-23T11:50:00.000Z","candidate":null,"primaryReason":{"code":"ready_flag_plan","text":"The engine-owned long flag plan is ready at 1000."},"qualityBand":"high",
 "supports":["rr_ok","ready_flag_plan","ema21_flag_context","top_down_context","first_level_ahead","td:bull:4/4","a200:5/7","ema200:1m:above","4h:with","level:15m:1050","divergence_agrees","data_fresh"],
 "opposes":[],"unknowns":["ema200:1w:missing"],
 "changeConditions":[{"code":"call_changes_on_invalidation","text":"Call changes if price invalidates the plan at 990, TP1 becomes blocked below 3R gross, or required data goes stale."}]}
```

```
BTC — 21/200 FLAG — GOOD
Setup: ready long flag plan BTC:1m:long:2026-09-23T11:50:00.000Z
Entry 1000 | Stop 990 | TP1 1040 | Gross R:R 4 | Net R:R 3.2

Supports: ready plan; gross R:R 4 ≥ 3R; top-down bull 4/4; above EMA200 on 5/7; 1m above EMA200; 4h with; first 15m level 1050 beyond the target; bullish divergence; data fresh
Against: none
Unknown: weekly EMA200
What changes the call: price invalidates at 990, TP1 blocked below 3R gross, or data goes stale
```

### WATCH (no plan, candidate named)

```json
{"class":"WATCH","candidateId":null,
 "candidate":{"candidateId":"BTC:3m:long:2026-09-23T11:30:00.000Z","timeframe":"3m","direction":"long","state":"forming","breakout":84466.1,"invalidation":84300,"measuredRR":3.5},
 "primaryReason":{"code":"need_confirmed_flag_plan","text":"3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it"},"readiness":"no_plan",
 "supports":["candidate:3m-long-forming","td:bull:4/4","a200:5/7","ema200:3m:above","4h:with","divergence_agrees","data_fresh"],
 "opposes":[],"unknowns":["ema200:1w:missing","level:none"],
 "changeConditions":[{"code":"need_confirmed_flag_plan","text":"3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it"}]}
```

```
BTC — 21/200 FLAG — WATCH
Nearest flag: forming 3m long, breakout 84,466.10, invalidation 84,300.00, measured 3.5R

Supports: top-down bull 4/4; above EMA200 on 5/7; 3m above EMA200; 4h with; bullish divergence; data fresh
Against: none
Unknown: weekly EMA200; no 15m level beyond the breakout
What changes the call: 3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it
```

With no flag at all the change condition reads `a 1m/3m/5m flag must form (none detected)`, `candidate` is null, and the directional context moves to `unknowns`.

### BAD

```json
{"class":"BAD","candidateId":"BTC:1m:long:2026-09-23T11:50:00.000Z","candidate":null,"primaryReason":{"code":"chase","text":"The engine rejected the flag plan: chase."},"readiness":"rejected",
 "supports":["td:bull:4/4","a200:5/7","ema200:1m:above","4h:with","divergence_agrees","data_fresh"],
 "opposes":["chase","conflict:5m-short"],"unknowns":["ema200:1w:missing","level:none"],
 "changeConditions":[{"code":"new_valid_plan","text":"wait for a 1m retest of 2,678.79 that holds above it"}]}
```

```
BTC — 21/200 FLAG — BAD
Against (disqualifying first): chase; 5m short flag conflicts
Supports (context only, not enough for a call): top-down bull 4/4; above EMA200 on 5/7; 1m above EMA200; 4h with; bullish divergence; data fresh
Unknown: weekly EMA200; no 15m level beyond the breakout
What changes the call: wait for a 1m retest of 2,678.79 that holds above it
```

Other rejection remedies: `rr_below_min` → `a flag whose measured move is >= 3R gross to TP1 (now 2.5R[, TP1 capped at X])`; `room_at_entry` → `a flag whose entry is clear of resistance (entry X sits inside a resistance zone)` (support for shorts); `stop_distance_exceeds_cap` → `a flag whose stop is within 3% of entry (now X%)`; `invalid_levels` → `a flag with its stop below and measured target above the breakout` (mirrored for shorts).

### DATA_UNAVAILABLE

```json
{"class":"DATA_UNAVAILABLE","candidateId":null,"candidate":null,"primaryReason":{"code":"stale_data:1m","text":"BTC 1m closed candles are stale; no flag call is made on them."},
 "supports":[],"opposes":[],
 "unknowns":["stale_data:1m","td:bull:4/4","a200:5/7","ema200:1w:missing","4h:bull","divergence_undirected"],
 "changeConditions":[{"code":"fresh_closed_candles","text":"Refresh 1m closed candles and rebuild."}]}
```

```
BTC — 21/200 FLAG — DATA_UNAVAILABLE
Supports: none fabricated
Against: none; stale data is not bearish or bullish evidence
Unknown: 1m closed candles stale (first); context cited undirected: top-down bull 4/4, above EMA200 on 5/7, weekly EMA200, 4h bull, divergence
What changes the call: refresh 1m closed candles and rebuild
```

## Acceptance Fixture Coverage

`npm run test:flagrec:fixtures` (`test-flag-recommendation-fixtures.js`, schema 1.18.0, pinned clock `2026-09-23T12:00:00Z`). Every case asserts class, `primaryReason.code`, specific support/oppose/unknown codes, the `changeConditions` text, and byte-stable output; directional cases run long and short. `owner` = maps to an owner-answered decision; the rest are `provisional`.

| Case | Class | Key codes / text | Label |
| --- | --- | --- | --- |
| Aligned bull flag | GOOD | `td:bull:4/4`, `a200:5/7`, `ema200:1m:above`, `4h:with`, `level:15m:1050` | provisional |
| Aligned bear flag (mirror) | GOOD | `td:bear:4/4`, `a200:2/7`, `ema200:1m:below`, `level:15m:950` | provisional |
| Mixed top-down | GOOD (lower score) / WATCH when conditional | oppose `td:mixed:2/4` | owner (alignment never vetoes) |
| Short above EMA200 | GOOD | oppose `ema200:1m:above`, `a200:5/7` | owner (EMA200 never filters) |
| Long below EMA200 | GOOD | oppose `ema200:1m:below`, `a200:2/7` | owner (EMA200 never filters) |
| Channel-edge fade, high breakout risk | GOOD (not vetoed) | oppose `chan:15m:top:high` / `chan:15m:bottom:high`, `ct:4h` | provisional |
| Measured target blocked by earlier level | GOOD | oppose `tp1_capped:1030`, `level:15m:1030`, `net_rr_low` | owner (4a own timeframe) |
| Divergence agreement | GOOD | support `divergence_agrees` | provisional |
| Divergence conflict | GOOD | oppose `divergence_conflicts` | provisional |
| Missing weekly EMA200 | GOOD, same score as with it | unknown `ema200:1w:missing` | provisional |
| Stale 1m, no plan | DATA_UNAVAILABLE | `stale_data:1m` first; "Refresh 1m closed candles and rebuild." | provisional |
| Flag forming, unconfirmed | WATCH | `candidate` named; "3m close above 84,466.10, then a retest that holds it, then plan ready; a close below 84,300.00 voids it" | owner (2a) |
| Valid geometry, gross < 3R | BAD `rr_below_min` | opposes[0]; "a flag whose measured move is >= 3R gross to TP1 (now 2.5R)" | owner (1a) |
| Price past entry (chase) | BAD `chase` | opposes[0]; "wait for a 1m retest of 2,678.79 that holds above it" | provisional |
| No flag | WATCH | "a 1m/3m/5m flag must form (none detected)"; context in unknowns | provisional |
| Other rejections | BAD | room / stop cap / invalid-levels remedies | provisional |

## GPT Manual Update Checklist

The deployed Custom GPT materials were not accessible from this local task, so deployment alignment is not claimed.

1. Paste the fenced instruction block from `docs/GPT_INSTRUCTIONS.md` into the Custom GPT Instructions box.
2. Confirm `npm run check:gpt` remains at or under 7,990 units before copying.
3. Upload or replace the knowledge file with the current repository docs that describe schema 1.14.0, especially:
   - `docs/GPT_INSTRUCTIONS.md`
   - `docs/EDITTRADES_MCP_CONNECTOR.md`
   - `docs/TRADING_MODEL_DECISION_CONTRACT.md`
   - this review sheet
4. In a fresh chat, test fixed payloads for:
   - GOOD ready plan
   - WATCH conditional/no-plan
   - BAD `rr_below_min`
   - DATA_UNAVAILABLE `stale_data`
5. Verify the GPT:
   - uses `flagRecommendation.class` for the 21/200 call;
   - quotes `flagTradePlan` prices exactly;
   - separates Supports, Against, Unknown, and What changes;
   - labels legacy strategy output as legacy;
   - never presents `bestSignal` as the 21/200 recommendation when `flagTradePlan` is null or rejected.

## Unresolved Interpretations

- Owner review is still needed for the exact GOOD/WATCH/BAD thresholds beyond the hard requirements.
- The divergence detector is deterministic but simplified; chart-eye agreement should be reviewed on owner-labeled examples.
- Channel breakout risk currently uses compact basis tokens, not a full subjective chart read.
- Weekly EMA200 remains unavailable with current history.
- Replay and ledger scoring are gross level-touch diagnostics after readiness; they are not yet exact net closed-candle plan outcome scoring.
