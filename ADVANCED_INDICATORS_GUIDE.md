# 🎯 Advanced Indicators Guide

## Overview

The API now includes **VWAP, ATR, Bollinger Bands, and MA Stack** - professional-grade indicators that provide deeper market context for high-leverage trading and LLM-powered signal generation.

---

## 📊 Indicators Added

### 1. **VWAP (Volume Weighted Average Price)**

**Available on:** 5m, 15m, 1h (intraday timeframes)

**Purpose:**
- Identifies institutional average entry price
- Detects trapped positions (longs/shorts)
- Provides bias direction (long above VWAP, short below)
- Spots mean-reversion opportunities

**JSON Structure:**
```json
"vwap": {
  "value": 87174.63,
  "distancePct": 4.48,           // (price - vwap) / price * 100
  "above": true,                  // price > VWAP
  "below": false,
  "bias": "long",                 // "long" if above, "short" if below
  "atVwap": false,                // within 0.2% of VWAP
  "reversionZone": true           // > 2% away, likely to mean-revert
},
"vwapPositioning": {
  "trappedLongsLikely": false,    // price below VWAP + downtrend + distance < -0.5%
  "trappedShortsLikely": true     // price above VWAP + uptrend + distance > 0.5%
}
```

**Trading Logic:**
- **Above VWAP + Uptrend**: Long bias, shorts trapped
- **Below VWAP + Downtrend**: Short bias, longs trapped
- **At VWAP**: Potential bounce/rejection level
- **Reversion Zone**: Price stretched > 2%, expect pullback to VWAP

**Thresholds:**
- `atVwap`: |distance| < 0.2%
- `reversionZone`: |distance| > 2.0%
- `trappedLongs`: distance < -0.5% + DOWNTREND
- `trappedShorts`: distance > 0.5% + UPTREND

---

### 2. **ATR (Average True Range)**

**Available on:** All timeframes

**Purpose:**
- Measures market volatility
- Helps size positions appropriately
- Guides stop-loss placement
- Warns against over-leveraging in high volatility

**JSON Structure:**
```json
"volatility": {
  "atr": 1462.94,
  "atrPct": 1.6,                  // ATR as % of price
  "volatilityState": "NORMAL"     // LOW | NORMAL | HIGH
}
```

**Trading Logic:**
- **LOW** (< 0.5%): Tight range, expect breakout, can use tighter stops
- **NORMAL** (0.5-2.0%): Standard volatility, normal position sizing
- **HIGH** (> 2.0%): Wild swings, reduce leverage, wider stops

**Thresholds:**
- LOW: atrPct < 0.5%
- HIGH: atrPct > 2.0%

**Risk Management:**
- Stop Loss = 1.5 × ATR from entry
- Position Size = (Risk Amount) / (ATR × 1.5)
- Avoid 100x leverage when volatilityState = "HIGH"

---

### 3. **Bollinger Bands**

**Available on:** 4h, 1h, 15m

**Purpose:**
- Detects overbought/oversold conditions
- Identifies volatility squeezes (coiling before expansion)
- Provides dynamic support/resistance
- Combines well with pullback strategy

**JSON Structure:**
```json
"bollinger": {
  "mid": 87963.14,                // SMA(20) middle band
  "upper": 90938.48,              // mid + 2×std
  "lower": 84987.81,              // mid - 2×std
  "bandWidthPct": 6.76,           // (upper - lower) / mid * 100
  "squeeze": false,               // bandwidth < 2% (coiling)
  "pricePosPct": 100              // 0=lower, 50=mid, 100=upper
}
```

**Trading Logic:**
- **pricePosPct 0-20** (Near Lower Band): Oversold in range, potential bounce
- **pricePosPct 80-100** (Near Upper Band): Overbought in range, potential reversal
- **squeeze = true**: Low volatility, expect breakout soon
- **Uptrend + Lower Band Touch**: Strong long setup
- **Downtrend + Upper Band Touch**: Strong short setup

**Thresholds:**
- Squeeze: bandWidthPct < 2.0%
- Oversold: pricePosPct < 20
- Overbought: pricePosPct > 80

---

### 4. **MA Stack (EMA 21, 50, 200)**

**Available on:** 4h, 1h

**Purpose:**
- Confirms trend strength
- Identifies trend structure
- Validates setup quality
- Filters low-probability trades

**JSON Structure:**
```json
"movingAverages": {
  "ema21": 88270.98,
  "ema50": 88871.00,
  "ema200": 97745.24
},
"maStructure": {
  "bullStack": false,             // ema21 > ema50 > ema200
  "bearStack": true,              // ema21 < ema50 < ema200
  "flatStack": false              // neither (choppy)
}
```

**Trading Logic:**
- **bullStack = true**: Strong uptrend, favor long pullbacks
- **bearStack = true**: Strong downtrend, favor short pullbacks
- **flatStack = true**: Choppy, avoid or reduce size

**Best Setups:**
- Bull Stack + Price > EMA21 + Stoch Reset = **HIGH CONFIDENCE LONG**
- Bear Stack + Price < EMA21 + Stoch Reset = **HIGH CONFIDENCE SHORT**
- Flat Stack = **AVOID** or wait for clear break

---

## 🎯 Complete Example Response (4h)

```json
{
  "currentPrice": 91265.4,
  "ema21": 88270.98,
  "ema200": 97745.24,
  "stoch": {
    "k": 100,
    "d": 91.33,
    "condition": "OVERBOUGHT"
  },
  "pullback": {
    "distanceFrom21": 3.39,
    "state": "OVEREXTENDED"
  },
  "trend": "FLAT",
  "swingHigh": 91874,
  "swingLow": 85250,
  
  "candle": {
    "direction": "bull",
    "bodyPct": 46.48,
    "upperWickPct": 22.57,
    "lowerWickPct": 30.94,
    "closeRelativeToRange": 77.43
  },
  
  "priceAction": {
    "rejectionUp": false,
    "insideBar": true
  },
  
  "levels": {
    "nearestResistance": 91874,
    "nearestSupport": 85250,
    "distanceToResistancePct": 0.67,
    "atResistance": false
  },
  
  "volatility": {
    "atr": 1462.94,
    "atrPct": 1.6,
    "volatilityState": "NORMAL"
  },
  
  "bollinger": {
    "mid": 87963.14,
    "upper": 90938.48,
    "lower": 84987.81,
    "bandWidthPct": 6.76,
    "squeeze": false,
    "pricePosPct": 100
  },
  
  "movingAverages": {
    "ema21": 88270.98,
    "ema50": 88871.00,
    "ema200": 97745.24
  },
  
  "maStructure": {
    "bullStack": false,
    "bearStack": true,
    "flatStack": false
  }
}
```

---

## 🤖 LLM Trading Scenarios

### Scenario 1: High-Conviction Long Setup
```json
{
  "4h": {
    "trend": "UPTREND",
    "maStructure": { "bullStack": true },
    "stoch": { "condition": "OVERSOLD", "k": 25 },
    "pullback": { "state": "ENTRY_ZONE" },
    "volatility": { "volatilityState": "NORMAL" },
    "bollinger": { "pricePosPct": 15 }
  },
  "15m": {
    "vwap": { "above": true, "bias": "long" },
    "vwapPositioning": { "trappedShortsLikely": true }
  }
}
```

**LLM Analysis:** "**HIGH CONFIDENCE LONG** - Bull stack on 4h, oversold stoch near lower Bollinger, price above VWAP with trapped shorts. Normal volatility allows for tight stops. Entry: 21 EMA. SL: 1.5×ATR below entry."

---

### Scenario 2: Avoid - Choppy Market
```json
{
  "4h": {
    "trend": "FLAT",
    "maStructure": { "flatStack": true },
    "volatility": { "volatilityState": "HIGH", "atrPct": 2.5 },
    "bollinger": { "squeeze": true }
  }
}
```

**LLM Analysis:** "**NO TRADE** - Flat MA stack in high volatility with Bollinger squeeze. Market is choppy and coiling. Wait for clear breakout and trend confirmation before entering."

---

### Scenario 3: Mean Reversion Short
```json
{
  "4h": {
    "trend": "DOWNTREND",
    "maStructure": { "bearStack": true }
  },
  "15m": {
    "vwap": { "distancePct": 3.2, "reversionZone": true, "above": true },
    "vwapPositioning": { "trappedLongsLikely": true },
    "bollinger": { "pricePosPct": 95 }
  }
}
```

**LLM Analysis:** "**SHORT SETUP** - 4h bear stack, price 3.2% above VWAP (reversion zone), at upper Bollinger (95%). Trapped longs likely. Short with TP at VWAP. SL at recent swing high."

---

## 📋 Indicator Availability Matrix

| Indicator | 4h | 1h | 15m | 5m |
|-----------|----|----|-----|-----|
| VWAP | ❌ | ✅ | ✅ | ✅ |
| VWAP Positioning | ❌ | ✅ | ✅ | ✅ |
| ATR / Volatility | ✅ | ✅ | ✅ | ✅ |
| Bollinger Bands | ✅ | ✅ | ✅ | ❌ |
| MA Stack | ✅ | ✅ | ❌ | ❌ |

---

## ⚙️ Customization

All thresholds are configurable in `lib/advancedIndicators.js`:

```javascript
// VWAP thresholds
const atVwap = Math.abs(distancePct) < 0.2;      // Change 0.2 to adjust
const reversionZone = Math.abs(distancePct) > 2.0; // Change 2.0 to adjust

// ATR thresholds
if (atrPct < 0.5) volatilityState = 'LOW';       // Change 0.5
else if (atrPct > 2.0) volatilityState = 'HIGH'; // Change 2.0

// Bollinger squeeze
const squeeze = bandWidthPct < 2.0;               // Change 2.0

// Trapped positioning
const trappedLongsLikely = 
  vwap.below && trend === 'DOWNTREND' && vwap.distancePct < -0.5; // Change -0.5
```

---

## 🚀 API Usage

### Get All Indicators
```bash
curl "https://your-app.vercel.app/api/indicators/BTCUSDT?intervals=4h,1h,15m,5m"
```

### Get Specific Timeframe with Advanced Indicators
```bash
curl "https://your-app.vercel.app/api/indicators/BTCUSDT?intervals=15m" | jq '.timeframes."15m" | {vwap, volatility, bollinger}'
```

### Full Analysis with Strategy
```bash
curl "https://your-app.vercel.app/api/analyze/BTCUSDT" | jq '.analysis."4h" | {movingAverages, maStructure, volatility}'
```

---

## 📊 Trading Rules Summary

### VWAP Rules
- ✅ Long when: Above VWAP + Uptrend + Trapped Shorts
- ✅ Short when: Below VWAP + Downtrend + Trapped Longs
- ⚠️ Mean Revert when: reversionZone = true

### ATR Rules
- ✅ Normal volatility: Standard position sizing
- ⚠️ High volatility: Reduce leverage, widen stops
- ✅ Low volatility: Can use tighter stops, expect expansion

### Bollinger Rules
- ✅ Uptrend + Lower Band: Long pullback
- ✅ Downtrend + Upper Band: Short pullback
- ⚠️ Squeeze: Wait for expansion before entry

### MA Stack Rules
- ✅ Bull Stack: Only long setups
- ✅ Bear Stack: Only short setups
- ❌ Flat Stack: Avoid or reduce size

---

## 🔗 Related Documentation

- `ENRICHED_SCHEMA.md` - Candle analysis and price action
- `COMPACT_SCHEMA.md` - LLM-optimized format
- `README.md` - Project overview

