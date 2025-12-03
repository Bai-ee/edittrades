# Micro-Scalp Override - Sample JSON Responses

## Scenario 1: 4H FLAT + Micro-Scalp PRESENT

When the 4H timeframe is FLAT (blocking normal trades), but strict lower-timeframe confluence exists for a micro-scalp:

```json
{
  "symbol": "BTCUSDT",
  "currentPrice": 91181.4,
  "priceChange24h": 0.65,
  "analysis": {
    "4h": {
      "indicators": {
        "trend": "FLAT",
        "ema21": 87927.62,
        "ema200": 97806.04,
        "stoch": { "k": 100.0, "d": 75.15, "condition": "OVERBOUGHT" },
        "pullback": { "distanceFrom21": 3.10, "state": "OVEREXTENDED" }
      }
    },
    "1h": {
      "indicators": {
        "trend": "UPTREND",
        "ema21": 90850.5,
        "stoch": { "k": 35.2, "d": 28.4, "condition": "BULLISH" },
        "pullback": { "distanceFrom21": 0.36, "state": "ENTRY_ZONE" }
      }
    },
    "15m": {
      "indicators": {
        "trend": "UPTREND",
        "ema21": 91100.3,
        "stoch": { "k": 22.8, "d": 18.5, "condition": "OVERSOLD" },
        "pullback": { "distanceFrom21": 0.09, "state": "ENTRY_ZONE" },
        "swingLow": 90650.0
      }
    },
    "5m": {
      "indicators": {
        "trend": "UPTREND",
        "ema21": 91150.8,
        "stoch": { "k": 19.3, "d": 15.2, "condition": "OVERSOLD" },
        "pullback": { "distanceFrom21": 0.03, "state": "ENTRY_ZONE" },
        "swingLow": 90700.0,
        "currentPrice": 91181.4
      }
    }
  },
  "tradeSignal": {
    "valid": false,
    "direction": "flat",
    "reason": "4h trend is flat - no trade",
    "setupType": "4h",
    "confidence": 0
  },
  "microScalpEligible": true,
  "microScalp": {
    "valid": true,
    "direction": "long",
    "setupType": "MicroScalp",
    "confidence": 73,
    "entry": {
      "min": 90671.60,
      "max": 91128.14
    },
    "stopLoss": 90650.00,
    "targets": {
      "tp1": 91550.55,
      "tp2": 91900.83
    },
    "riskReward": {
      "tp1RR": 1.0,
      "tp2RR": 1.5
    },
    "invalidation_level": 90650.00,
    "invalidation_description": "5m close below 90650.00",
    "reason": "1H uptrend, 15m/5m at EMA21 (0.09%/0.03%), stoch oversold/bullish momentum",
    "currentPrice": 91181.40,
    "timestamp": "2025-11-28T10:30:00.000Z"
  },
  "timestamp": "2025-11-28T10:30:00.000Z"
}
```

**Key Points:**
- ✅ `tradeSignal.valid` = `false` (4H FLAT blocks normal trades)
- ✅ `microScalpEligible` = `true` (conditions met for micro-scalp)
- ✅ `microScalp.valid` = `true` (micro-scalp opportunity exists)
- ✅ `microScalp.setupType` = `"MicroScalp"`
- ✅ Confidence: 73% (based on tight 15m/5m EMA21 confluence)
- ✅ Entry: Average of 15m & 5m EMA21 (91125.55)
- ✅ SL: Min of 15m & 5m swing lows (90650.00)
- ✅ Targets: 1.0R and 1.5R

---

## Scenario 2: 4H FLAT + Micro-Scalp ABSENT

When the 4H timeframe is FLAT and lower-timeframe confluence is NOT sufficient for a micro-scalp:

```json
{
  "symbol": "ETHUSDT",
  "currentPrice": 3420.75,
  "priceChange24h": -1.25,
  "analysis": {
    "4h": {
      "indicators": {
        "trend": "FLAT",
        "ema21": 3385.20,
        "ema200": 3550.80,
        "stoch": { "k": 55.3, "d": 52.1, "condition": "NEUTRAL" },
        "pullback": { "distanceFrom21": 1.05, "state": "RETRACING" }
      }
    },
    "1h": {
      "indicators": {
        "trend": "FLAT",
        "ema21": 3410.50,
        "stoch": { "k": 48.2, "d": 51.3, "condition": "NEUTRAL" },
        "pullback": { "distanceFrom21": 0.30, "state": "ENTRY_ZONE" }
      }
    },
    "15m": {
      "indicators": {
        "trend": "DOWNTREND",
        "ema21": 3425.80,
        "stoch": { "k": 65.5, "d": 68.2, "condition": "NEUTRAL" },
        "pullback": { "distanceFrom21": -0.15, "state": "ENTRY_ZONE" },
        "swingHigh": 3455.00
      }
    },
    "5m": {
      "indicators": {
        "trend": "UPTREND",
        "ema21": 3418.20,
        "stoch": { "k": 72.8, "d": 70.5, "condition": "NEUTRAL" },
        "pullback": { "distanceFrom21": 0.07, "state": "ENTRY_ZONE" },
        "swingLow": 3395.00,
        "currentPrice": 3420.75
      }
    }
  },
  "tradeSignal": {
    "valid": false,
    "direction": "flat",
    "reason": "4h trend is flat - no trade",
    "setupType": "4h",
    "confidence": 0
  },
  "microScalpEligible": false,
  "microScalp": null,
  "timestamp": "2025-11-28T10:30:00.000Z"
}
```

**Why No Micro-Scalp:**
- ❌ `microScalpEligible` = `false`
- ❌ `microScalp` = `null`
- **Reason**: 1H trend is FLAT (fails HIGH-TIMEFRAME GUARDRAIL #1)
- Even though price is near EMA21 on lower timeframes, the 1H must be trending for micro-scalp eligibility

---

## Scenario 3: 4H UPTREND + Normal Trade + No Micro-Scalp

When the 4H timeframe is trending (normal trade is valid), micro-scalp is not relevant:

```json
{
  "symbol": "SOLUSDT",
  "currentPrice": 245.80,
  "priceChange24h": 3.45,
  "analysis": {
    "4h": {
      "indicators": {
        "trend": "UPTREND",
        "ema21": 242.50,
        "ema200": 225.30,
        "stoch": { "k": 65.2, "d": 58.3, "condition": "BULLISH" },
        "pullback": { "distanceFrom21": 1.36, "state": "ENTRY_ZONE" }
      }
    },
    "1h": {
      "indicators": {
        "trend": "UPTREND",
        "ema21": 244.20,
        "stoch": { "k": 55.8, "d": 52.1, "condition": "BULLISH" },
        "pullback": { "distanceFrom21": 0.66, "state": "ENTRY_ZONE" }
      }
    }
  },
  "tradeSignal": {
    "valid": true,
    "direction": "long",
    "setupType": "4h",
    "confidence": 78,
    "entry_zone": { "min": 242.00, "max": 243.00 },
    "stop_loss": 238.50,
    "targets": [247.50, 252.00],
    "risk_reward": { "tp1RR": 1.5, "tp2RR": 2.4 },
    "reason": "4h uptrend, 1h aligned, price at entry zone"
  },
  "microScalpEligible": true,
  "microScalp": null,
  "timestamp": "2025-11-28T10:30:00.000Z"
}
```

**Key Points:**
- ✅ `tradeSignal.valid` = `true` (normal 4H trade is available)
- ✅ `microScalpEligible` = `true` (1H is trending, guardrails pass)
- ❌ `microScalp` = `null` (no micro-scalp signal because normal trade takes priority OR LTF confluence not tight enough)
- **Usage**: Use the main `tradeSignal` for trading decisions

---

## Micro-Scalp Eligibility Criteria Summary

### ✅ Eligible When:
1. **1H trend** = `UPTREND` or `DOWNTREND` (NOT `FLAT`)
2. **1H pullback** = `ENTRY_ZONE` or `RETRACING`

### ✅ Valid Signal When (in addition to eligibility):
3. **15m & 5m near EMA21**: Both within ±0.25% (`distanceFrom21EMA`)
4. **15m & 5m pullback state**: Both `ENTRY_ZONE` or `RETRACING`
5. **Stoch momentum aligned**:
   - **LONG**: Oversold (k<25) OR Bullish with k<40 on both 15m & 5m
   - **SHORT**: Overbought (k>75) OR Bearish with k>60 on both 15m & 5m

---

## Frontend Display Recommendation

When displaying in UI:

```javascript
// Check for any valid trade signal
if (data.tradeSignal.valid) {
  // Display normal trade (Swing/Scalp/4h)
  displayNormalTrade(data.tradeSignal);
} else if (data.microScalpEligible && data.microScalp && data.microScalp.valid) {
  // Display micro-scalp opportunity
  displayMicroScalp(data.microScalp);
} else {
  // No trade
  displayNoTrade(data.tradeSignal.reason);
}
```

**Visual Distinction:**
- Normal trades: Standard display
- Micro-scalp: Add badge/label "MICRO-SCALP" with yellow/orange color
- Show disclaimer: "Lower timeframe trade - tighter stops, smaller size"

---

## API Backwards Compatibility

✅ **Guaranteed:**
- Existing fields remain unchanged
- `tradeSignal` structure unchanged
- Old clients ignore new `microScalpEligible` and `microScalp` fields
- No breaking changes

✅ **New Capabilities:**
- LLM agents can reason about micro-scalp opportunities
- Frontend can display alternative trading setups
- Users get more trading opportunities during FLAT markets

