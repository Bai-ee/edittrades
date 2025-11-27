# 📊 Enriched API Schema - Advanced Candle Analysis

## Overview

The API now includes **advanced candle-level analysis** designed to provide LLMs and traders with deeper insights into price action, support/resistance, and recent market structure.

---

## ✨ New Fields Added

### 1. **Candle Analysis** (All Timeframes)
Detailed breakdown of the current candle structure:

```json
"candle": {
  "direction": "bull",              // "bull" | "bear" | "doji"
  "bodyPct": 7.07,                  // body size as % of total range (0-100)
  "upperWickPct": 61.99,            // upper wick as % of total range
  "lowerWickPct": 30.94,            // lower wick as % of total range
  "closeRelativeToRange": 38.01,   // where close is within high-low (0=low, 100=high)
  "closeAboveEma21": true,          // boolean: close > 21 EMA
  "closeBelowEma21": false,         // boolean: close < 21 EMA
  "range": {
    "open": 91133.2,
    "high": 91329.6,
    "low": 91045.2,
    "close": 91153.3
  }
}
```

**Use Cases:**
- Detect rejection wicks (high upper/lower wick %)
- Identify strong/weak bodies
- Confirm EMA interactions
- LLM can infer momentum and conviction

---

### 2. **Price Action Patterns** (All Timeframes)
Simple pattern detection from last 2 candles:

```json
"priceAction": {
  "rejectionUp": true,       // long upper wick + small body near low
  "rejectionDown": false,    // long lower wick + small body near high
  "engulfingBull": false,    // current bull candle engulfs previous bear
  "engulfingBear": false,    // current bear candle engulfs previous bull
  "insideBar": true          // current high/low inside previous candle
}
```

**Detection Rules:**
- **Rejection Up**: Upper wick >50% of range, body <30%, close near low
- **Rejection Down**: Lower wick >50% of range, body <30%, close near high
- **Engulfing Bull**: Bull candle fully engulfs previous bear
- **Engulfing Bear**: Bear candle fully engulfs previous bull
- **Inside Bar**: Current candle completely inside previous range

**Use Cases:**
- Spot potential reversals (rejections)
- Identify momentum shifts (engulfing)
- Detect consolidation (inside bars)
- Combine with trend for confirmation

---

### 3. **Support & Resistance Levels** (4h & 1h Only)
Nearest key levels based on swing points:

```json
"levels": {
  "nearestResistance": 91874.0,
  "nearestSupport": 85250.0,
  "distanceToResistancePct": 0.79,
  "distanceToSupportPct": 6.48,
  "atResistance": false,          // within 0.5% of resistance
  "atSupport": false,             // within 0.5% of support
  "brokeResistanceOnClose": false,
  "brokeSupportOnClose": false
}
```

**Calculation:**
- Derived from pre-computed swing highs/lows
- Falls back to pivot detection if needed
- Nearest level above price = resistance
- Nearest level below price = support

**Use Cases:**
- Identify key price zones
- Detect breakouts (broke* flags)
- Calculate risk/reward based on levels
- Avoid trading into resistance/support

---

### 4. **Recent Candles** (5m Trigger TF Only)
Last 5 candles for pattern recognition:

```json
"recentCandles": [
  { "open": 91166.4, "high": 91329.6, "low": 91166.3, "close": 91329.6 },
  { "open": 91329.6, "high": 91329.6, "low": 91250.0, "close": 91250.0 },
  { "open": 91249.4, "high": 91249.4, "low": 91199.6, "close": 91199.8 },
  { "open": 91208.6, "high": 91300.0, "low": 91145.9, "close": 91153.3 },
  { "open": 91153.3, "high": 91153.3, "low": 91143.4, "close": 91143.4 }
]
```

**Order:** Oldest → Newest (last candle is most recent)

**Use Cases:**
- LLM can infer higher highs/lower lows
- Detect V-shape vs grind patterns
- Identify momentum strength/weakness
- Spot micro structure breaks

---

## 🎯 Complete Example Response

### GET `/api/indicators/BTCUSDT?intervals=4h`

```json
{
  "symbol": "BTCUSDT",
  "source": "kraken",
  "timeframes": {
    "4h": {
      "currentPrice": 91153.3,
      "ema21": 88260.79,
      "ema200": 97744.13,
      "stoch": {
        "k": 100.0,
        "d": 91.33,
        "condition": "OVERBOUGHT"
      },
      "pullback": {
        "distanceFrom21": 3.28,
        "state": "OVEREXTENDED"
      },
      "trend": "FLAT",
      "swingHigh": 91874.0,
      "swingLow": 85250.0,
      "candleCount": 500,
      
      "candle": {
        "direction": "bull",
        "bodyPct": 7.07,
        "upperWickPct": 61.99,
        "lowerWickPct": 30.94,
        "closeRelativeToRange": 38.01,
        "closeAboveEma21": true,
        "closeBelowEma21": false,
        "range": {
          "open": 91133.2,
          "high": 91329.6,
          "low": 91045.2,
          "close": 91153.3
        }
      },
      
      "priceAction": {
        "rejectionUp": true,
        "rejectionDown": false,
        "engulfingBull": false,
        "engulfingBear": false,
        "insideBar": true
      },
      
      "levels": {
        "nearestResistance": 91874.0,
        "nearestSupport": 85250.0,
        "distanceToResistancePct": 0.79,
        "distanceToSupportPct": 6.48,
        "atResistance": false,
        "atSupport": false,
        "brokeResistanceOnClose": false,
        "brokeSupportOnClose": false
      }
    }
  },
  "timestamp": "2025-11-27T12:00:00.000Z"
}
```

---

## 📋 Field Availability Matrix

| Field | 4h | 1h | 15m | 5m |
|-------|----|----|-----|-----|
| **Existing Fields** |
| currentPrice | ✅ | ✅ | ✅ | ✅ |
| ema21, ema200 | ✅ | ✅ | ✅ | ✅ |
| stoch | ✅ | ✅ | ✅ | ✅ |
| pullback | ✅ | ✅ | ✅ | ✅ |
| trend | ✅ | ✅ | ✅ | ✅ |
| swingHigh, swingLow | ✅ | ✅ | ✅ | ✅ |
| **New Fields** |
| candle | ✅ | ✅ | ✅ | ✅ |
| priceAction | ✅ | ✅ | ✅ | ✅ |
| levels | ✅ | ✅ | ❌ | ❌ |
| recentCandles | ❌ | ❌ | ❌ | ✅ |

---

## 🤖 LLM Usage Examples

### Example 1: Rejection Analysis
```json
{
  "candle": { "upperWickPct": 62, "bodyPct": 7 },
  "priceAction": { "rejectionUp": true },
  "levels": { "atResistance": false, "distanceToResistancePct": 0.79 }
}
```
**LLM Interpretation:** "Price showed rejection with 62% upper wick just below resistance (0.79% away). Weak conviction (7% body). Potential short setup."

### Example 2: Breakout Confirmation
```json
{
  "candle": { "direction": "bull", "bodyPct": 75, "closeAboveEma21": true },
  "priceAction": { "engulfingBull": true },
  "levels": { "brokeResistanceOnClose": true }
}
```
**LLM Interpretation:** "Strong bullish breakout. Engulfing pattern with 75% body broke resistance. High conviction move."

### Example 3: Recent Momentum (5m)
```json
{
  "recentCandles": [
    { "high": 91300, "low": 91200 },
    { "high": 91400, "low": 91250 },
    { "high": 91500, "low": 91350 }
  ]
}
```
**LLM Interpretation:** "Higher highs and higher lows pattern. Building momentum to the upside."

---

## 🔧 Implementation Details

### Helper Modules
- **`lib/candleFeatures.js`**: Candle metrics and price action detection
- **`lib/levels.js`**: Support/resistance calculation and break detection

### Integration Points
- **`api/indicators.js`**: Enriches all timeframes
- **`api/analyze.js`**: Enriches analysis object for strategy engine

### Backward Compatibility
- ✅ All existing fields preserved
- ✅ New fields are additive only
- ✅ Frontend continues to work without changes
- ✅ Clients can ignore new fields if not needed

---

## 📊 Use Cases

### For LLMs (ChatGPT, Claude, etc.)
- **Better Context**: Candle structure + price action + levels = comprehensive picture
- **Pattern Recognition**: Detect setups without needing raw OHLC arrays
- **Risk Management**: Use support/resistance for SL/TP calculation
- **Momentum Analysis**: Recent candles show micro-trends

### For Traders
- **Quick Rejection Spots**: Look for `rejectionUp/Down` flags
- **Level Awareness**: Know distance to key S/R zones
- **Pattern Confirmation**: Combine engulfing + trend alignment
- **Entry Timing**: Use 5m `recentCandles` for precise entries

### For Automated Systems
- **Rule-Based Filters**: `if (priceAction.rejectionUp && levels.atResistance) { ... }`
- **Confidence Scoring**: Weight signals higher when multiple patterns align
- **Dynamic SL Placement**: Use `nearestSupport/Resistance` for stops
- **Break Trading**: Act on `brokeResistanceOnClose` flags

---

## 🚀 Example API Calls

### Get Full Analysis
```bash
curl "https://your-app.vercel.app/api/analyze/BTCUSDT?intervals=4h,1h,15m,5m"
```

### Get Just Indicators (Cleaner)
```bash
curl "https://your-app.vercel.app/api/indicators/BTCUSDT?intervals=4h,1h,15m,5m"
```

### Get Specific Timeframe
```bash
curl "https://your-app.vercel.app/api/indicators/BTCUSDT?intervals=5m" | jq '.timeframes."5m"'
```

---

## ⚙️ Customization

### Adjust Thresholds
Edit `lib/candleFeatures.js` and `lib/levels.js` to tweak:
- Rejection wick threshold (currently 50%)
- Body size threshold (currently 30%)
- "At level" distance (currently 0.5%)
- Recent candles count (currently 5)

### Add More Patterns
Extend `detectPriceAction()` function with:
- Hammer/shooting star
- Three white soldiers
- Morning/evening star
- Etc.

---

## 📝 Notes

1. **Performance**: Minimal overhead (~5-10ms per timeframe)
2. **Data Required**: Uses existing candle arrays, no extra API calls
3. **Accuracy**: Simple deterministic rules, not ML-based
4. **Reliability**: Works with any symbol/timeframe combination

---

## 🔗 Related Documentation

- `COMPACT_SCHEMA.md` - LLM-optimized compact format
- `API_QUICK_REFERENCE.md` - Quick API reference
- `README.md` - Project overview

