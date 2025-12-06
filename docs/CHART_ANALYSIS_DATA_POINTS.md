# Chart Analysis Data Points - Available in Frontend & JSON

## Overview

All new chart-based analysis data points are now available in:
1. **Frontend Display** - Market Data section (above Prediction Markets)
2. **Copied JSON** - Included in `copyAllCoins()` output
3. **API Responses** - Available in `/api/analyze` and `/api/indicators`

---

## New Data Points Available

### 1. Candlestick Patterns (Per Timeframe)

**Location:** `timeframes[timeframe].candlestickPatterns`

**Data Points:**
- `current` - Primary pattern detected (e.g., "HAMMER", "ENGULFING_BULL", "MORNING_STAR")
- `confidence` - Pattern confidence score (0-1, e.g., 0.75 = 75%)
- `bullish` - Boolean: Is pattern bullish?
- `bearish` - Boolean: Is pattern bearish?
- `patterns` - Array of all patterns detected (e.g., ["HAMMER", "ENGULFING_BULL"])

**Available Patterns:**
- Bullish: HAMMER, ENGULFING_BULL, MORNING_STAR, PIERCING_PATTERN, THREE_WHITE_SOLDIERS, INVERTED_HAMMER, HARAMI_BULL
- Bearish: HANGING_MAN, ENGULFING_BEAR, EVENING_STAR, DARK_CLOUD_COVER, THREE_BLACK_CROWS, SHOOTING_STAR, HARAMI_BEAR
- Neutral: DOJI, SPINNING_TOP, MARUBOZU

**Example:**
```json
{
  "candlestickPatterns": {
    "current": "HAMMER",
    "confidence": 0.75,
    "bullish": true,
    "bearish": false,
    "patterns": ["HAMMER"]
  }
}
```

---

### 2. Wick/Body Analysis (Per Timeframe)

**Location:** `timeframes[timeframe].wickAnalysis`

**Data Points:**
- `upperWickDominance` - Upper wick as % of total range (0-100)
- `lowerWickDominance` - Lower wick as % of total range (0-100)
- `bodyDominance` - Body as % of total range (0-100)
- `exhaustionSignal` - Exhaustion type: "LOWER_WICK_REJECTION", "UPPER_WICK_REJECTION", "DOUBLE_WICK_INDECISION", or "NONE"
- `upperWickSize` - Absolute upper wick size
- `lowerWickSize` - Absolute lower wick size
- `bodySize` - Absolute body size
- `range` - Total candle range (high - low)
- `wickDominance` - Enhanced analysis object:
  - `dominantWick` - "UPPER", "LOWER", "BOTH", or "NONE"
  - `wickRatio` - Ratio of larger wick to smaller wick
- `bodyStrength` - Body strength analysis:
  - `bodyStrength` - Body strength percentage
  - `bodyStrengthCategory` - "WEAK", "MODERATE", "STRONG", or "VERY_STRONG"
- `exhaustionSignals` - Exhaustion detection:
  - `exhaustionSignal` - Signal type
  - `exhaustionType` - "BULLISH", "BEARISH", or "NEUTRAL"
  - `confidence` - Exhaustion confidence (0-1)

**Example:**
```json
{
  "wickAnalysis": {
    "upperWickDominance": 15.2,
    "lowerWickDominance": 65.8,
    "exhaustionSignal": "LOWER_WICK_REJECTION",
    "wickDominance": {
      "dominantWick": "LOWER",
      "wickRatio": 4.32
    },
    "bodyStrength": {
      "bodyStrength": 19.0,
      "bodyStrengthCategory": "WEAK"
    }
  }
}
```

---

### 3. Trend Strength (ADX) (Per Timeframe)

**Location:** `timeframes[timeframe].trendStrength`

**Data Points:**
- `adx` - ADX value (0-100+)
- `strong` - Boolean: ADX ≥ 25 (strong trend)
- `weak` - Boolean: ADX < 25 (weak trend)
- `veryStrong` - Boolean: ADX ≥ 40 (very strong trend)
- `category` - Category string: "WEAK", "MODERATE", "STRONG", or "VERY_STRONG"

**ADX Interpretation:**
- < 20: Weak trend (choppy/sideways)
- 20-25: Moderate trend
- 25-40: Strong trend
- ≥ 40: Very strong trend (may be overextended)

**Example:**
```json
{
  "trendStrength": {
    "adx": 28.5,
    "strong": true,
    "weak": false,
    "veryStrong": false,
    "category": "STRONG"
  }
}
```

---

### 4. RSI (Relative Strength Index) (Per Timeframe)

**Location:** `timeframes[timeframe].rsi`

**Data Points:**
- `value` - RSI value (0-100)
- `overbought` - Boolean: RSI > 70
- `oversold` - Boolean: RSI < 30
- `history` - Array of RSI values (for historical analysis)

**Example:**
```json
{
  "rsi": {
    "value": 45.2,
    "overbought": false,
    "oversold": false,
    "history": [45.2, 44.8, 46.1, ...]
  }
}
```

---

### 5. Multi-Timeframe Momentum Alignment (Root Level)

**Location:** `momentum` (root level in analyze endpoint, included in copied JSON)

**Data Points:**
- `alignment` - Overall alignment: "BULLISH", "BEARISH", "BULLISH_WEAK", "BEARISH_WEAK", "NEUTRAL", or "UNKNOWN"
- `alignmentScore` - Alignment score (0-100)
- `bullishCount` - Number of timeframes showing bullish momentum
- `bearishCount` - Number of timeframes showing bearish momentum
- `neutralCount` - Number of timeframes showing neutral momentum
- `totalTimeframes` - Total timeframes analyzed
- `timeframes` - Per-timeframe momentum breakdown:
  - `[timeframe].momentum` - Momentum direction for this TF
  - `[timeframe].momentumStrength` - Momentum strength (0-100)
  - `[timeframe].stochRSI` - Stoch RSI values (k, d)
  - `[timeframe].rsi` - RSI value (if available)
- `score` - Momentum score breakdown:
  - `score` - Overall momentum score (0-100)
  - `alignment` - Alignment type
  - `consensusRatio` - Consensus ratio (0-1)
- `bias` - Overall momentum bias:
  - `bias` - "BULLISH", "BEARISH", or "NEUTRAL"
  - `strength` - Bias strength (0-100)
  - `confidence` - "HIGH" or "MEDIUM"

**Example:**
```json
{
  "momentum": {
    "alignment": "BULLISH",
    "alignmentScore": 75.5,
    "bullishCount": 4,
    "bearishCount": 1,
    "neutralCount": 0,
    "totalTimeframes": 5,
    "timeframes": {
      "1m": {
        "momentum": "BULLISH",
        "momentumStrength": 65.2,
        "stochRSI": { "k": 35, "d": 40 },
        "rsi": 45.2
      },
      "5m": { ... },
      "15m": { ... },
      "1h": { ... },
      "4h": { ... }
    },
    "score": {
      "score": 82.5,
      "alignment": "BULLISH",
      "consensusRatio": 0.8
    },
    "bias": {
      "bias": "BULLISH",
      "strength": 75.5,
      "confidence": "HIGH"
    }
  }
}
```

---

## Frontend Display Location

**Market Data Section** (in descriptions dropdown):
- Located above "Prediction Markets" section
- Shows 4H Chart Analysis:
  - Candlestick Pattern (with confidence)
  - Exhaustion Signal (if present)
  - ADX (Trend Strength)
  - RSI
- Shows Multi-Timeframe Momentum:
  - Alignment (BULLISH/BEARISH/NEUTRAL)
  - Alignment Score
  - Bullish/Bearish Timeframe Counts

---

## JSON Structure in Copied Data

When using `copyAllCoins()`, the JSON includes:

```json
{
  "SAFE_MODE": {
    "BTCUSDT": {
      "symbol": "BTCUSDT",
      "timeframes": {
        "4h": {
          "candlestickPatterns": { ... },
          "wickAnalysis": { ... },
          "trendStrength": { ... },
          "rsi": { ... }
        },
        "1h": { ... }
      },
      "momentum": { ... },
      "marketData": { ... },
      "dflowData": { ... }
    }
  }
}
```

---

## All Available Data Points Summary

### Per Timeframe (4h, 1h, 15m, 5m):
1. ✅ **Candlestick Patterns** - Pattern name, confidence, bullish/bearish
2. ✅ **Wick Analysis** - Upper/lower wick dominance, exhaustion signals
3. ✅ **Trend Strength (ADX)** - ADX value, strength category
4. ✅ **RSI** - RSI value, overbought/oversold status

### Root Level:
5. ✅ **Momentum Alignment** - Multi-timeframe momentum analysis
   - Overall alignment (BULLISH/BEARISH/NEUTRAL)
   - Alignment score (0-100)
   - Per-timeframe momentum breakdown
   - Consensus ratio and bias

---

## Integration Status

✅ **Frontend Display** - Chart Analysis section added to Market Data
✅ **JSON Copy** - All data points included in `copyAllCoins()` output
✅ **API Endpoints** - Available in `/api/analyze` and `/api/indicators`
✅ **Strategy Integration** - Used in confidence calculation
✅ **Documentation** - Complete guide in `docs/CHART_ANALYSIS_GUIDE.md`

---

**Last Updated:** 2024-12-06

