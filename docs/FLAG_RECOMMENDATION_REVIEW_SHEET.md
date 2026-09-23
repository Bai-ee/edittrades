# Flag Recommendation Review Sheet

Created: 2026-09-23  
Scope: schema 1.14.0 local implementation. These examples are deterministic fixtures for communication fidelity. They are not profitability evidence.

## Representative Outputs

### GOOD

```
BTC — 21/200 FLAG — GOOD
Setup: ready long flag plan BTC:1m:long:2026-09-23T11:50:00.000Z
Entry: 1000
Stop: 990
TP1: 1040
Net R:R: 3.2

Supports
- ready_flag_plan: The engine-owned long flag plan is ready at 1000.
- net_rr_ok: Net R:R to TP1 is 3.2, meeting the 3R floor.
- top_down_context: Top-down sentiment is bull with 4/4 aligned.
- ema21_flag_context: 1m price is above EMA21.
- divergence_agrees: Bullish Stoch RSI divergence confirms momentum.

Against
- None blocking. EMA200 side may be counter-context, not a veto.

Unknown
- Weekly EMA200 is unavailable because there is insufficient weekly history.

What Changes The Call
- Price invalidates the plan at 990, TP1 becomes blocked below 3R, or required data goes stale.
```

### WATCH

```
BTC — 21/200 FLAG — WATCH
Setup: valid long flag plan, not ready

Supports
- valid_conditional_plan: The engine has a valid conditional long flag plan with TP1 1040 and net R:R 3.2.

Against
- trade_readiness: status is conditional (awaiting_retest).

Unknown
- Confirmation has not happened on a closed candle.

What Changes The Call
- closed candle retests 1000 and holds at or above it.
```

### BAD

```
BTC — 21/200 FLAG — BAD
Setup: rejected long flag plan

Supports
- None sufficient for a trade call.

Against
- net_rr_below_3: The engine rejected the flag plan.
- net_rr: Net R:R is 2.7, below the 3R floor.

Unknown
- No missing-data issue; this is a hard risk/reward block.

What Changes The Call
- A fresh flag plan must pass levels, stop distance, and net R:R checks.
```

### DATA_UNAVAILABLE

```
BTC — 21/200 FLAG — DATA_UNAVAILABLE
Setup: selected plan exists but required data is stale

Supports
- None fabricated.

Against
- None; stale data is not bearish or bullish evidence.

Unknown
- stale_data: The selected flag plan is stale_data; the engine will not infer missing or stale candle data.

What Changes The Call
- Refresh the required closed candles and rebuild the plan.
```

## Acceptance Fixture Coverage

| Case | Expected Class | Key Reason Checked |
| --- | --- | --- |
| Aligned bull flag | GOOD | ready plan, net R >= 3, top-down support |
| Mirrored aligned bear flag | GOOD | same class, bearish divergence support |
| Mixed top-down context | GOOD with lower quality | alignment is context, not veto |
| Long below EMA200 | GOOD when other factors support | EMA200 side context only |
| Short above EMA200 | GOOD when other factors support | EMA200 side context only |
| Channel/level ahead | GOOD/WATCH with cited level | first level ahead named; TP1 still engine-owned |
| Divergence agreement | Adds support | `divergence_agrees` |
| Divergence conflict | Adds opposing evidence | no automatic veto |
| Missing weekly EMA200 | GOOD/WATCH unchanged | unknown provenance remains visible |
| Stale required data | DATA_UNAVAILABLE | no support fabricated |
| No flag plan | WATCH | no 21/200 fallback to legacy `bestSignal` |
| Net R below 3 | BAD | hard risk block |

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
   - BAD `net_rr_below_3`
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
