# Chart-Based Analysis Guide

## Overview

The chart-based analysis module enhances trading signals by detecting candlestick patterns, analyzing multi-timeframe momentum alignment, and providing advanced wick/body analysis. These insights are integrated into the strategy engine to improve trade confidence and entry timing.

---

## Features

### 1. Candlestick Pattern Recognition

Detects major candlestick patterns across all timeframes:

**Bullish Patterns:**
- **HAMMER** - Reversal pattern with long lower wick
- **ENGULFING_BULL** - Bullish candle engulfs previous bearish candle
- **MORNING_STAR** - Three-candle reversal pattern (bearish → small → bullish)
- **PIERCING_PATTERN** - Bullish candle pierces previous bearish candle's midpoint
- **THREE_WHITE_SOLDIERS** - Three consecutive bullish candles
- **INVERTED_HAMMER** - Reversal pattern at bottom
- **HARAMI_BULL** - Small bullish candle inside previous bearish candle

**Bearish Patterns:**
- **HANGING_MAN** - Reversal pattern with long lower wick (at top)
- **ENGULFING_BEAR** - Bearish candle engulfs previous bullish candle
- **EVENING_STAR** - Three-candle reversal pattern (bullish → small → bearish)
- **DARK_CLOUD_COVER** - Bearish candle covers previous bullish candle
- **THREE_BLACK_CROWS** - Three consecutive bearish candles
- **SHOOTING_STAR** - Reversal pattern at top
- **HARAMI_BEAR** - Small bearish candle inside previous bullish candle

**Neutral/Reversal Patterns:**
- **DOJI** - Indecision pattern (open ≈ close)
- **SPINNING_TOP** - Indecision with wicks on both sides
- **MARUBOZU** - Strong directional candle with minimal wicks

**Usage:**
```javascript
const patterns = indicators.candlestickPatterns;
// Returns:
{
  current: "HAMMER",           // Primary pattern detected
  confidence: 0.75,            // 0-1 confidence score
  bullish: true,               // Is pattern bullish?
  bearish: false,              // Is pattern bearish?
  patterns: ["HAMMER"]         // All patterns detected
}
```

**Integration with Strategy:**
- **Bullish patterns** on long trades: +5-15% confidence bonus
- **Bearish patterns** on short trades: +5-15% confidence bonus
- **Contradictory patterns**: -5-10% confidence penalty

---

### 2. Multi-Timeframe Momentum Alignment

Analyzes RSI and Stochastic RSI across multiple timeframes (1m, 5m, 15m, 1h, 4h) to determine momentum confluence.

**Alignment Types:**
- **BULLISH** - 60%+ of timeframes show bullish momentum
- **BEARISH** - 60%+ of timeframes show bearish momentum
- **BULLISH_WEAK** - 50-60% bullish momentum
- **BEARISH_WEAK** - 50-60% bearish momentum
- **NEUTRAL** - Mixed or neutral momentum
- **UNKNOWN** - Insufficient data

**Usage:**
```javascript
const momentum = analysis.momentum;
// Returns:
{
  alignment: "BULLISH",         // Overall alignment
  alignmentScore: 75.5,         // 0-100 score
  bullishCount: 4,              // Number of bullish timeframes
  bearishCount: 1,              // Number of bearish timeframes
  neutralCount: 0,              // Number of neutral timeframes
  totalTimeframes: 5,            // Total timeframes analyzed
  timeframes: {                 // Per-timeframe momentum
    "1m": { momentum: "BULLISH", momentumStrength: 65.2, ... },
    "5m": { momentum: "BULLISH", momentumStrength: 70.1, ... },
    ...
  },
  score: {                      // Momentum score breakdown
    score: 82.5,
    alignment: "BULLISH",
    consensusRatio: 0.8
  },
  bias: {                       // Overall momentum bias
    bias: "BULLISH",
    strength: 75.5,
    confidence: "HIGH"
  }
}
```

**Integration with Strategy:**
- **Aligned momentum** (score ≥ 60): +5-10% confidence bonus
- **Contradictory momentum** (score ≥ 60, wrong direction): -5-8% confidence penalty

---

### 3. Advanced Wick/Body Analysis

Provides detailed analysis of candle wicks and bodies to identify exhaustion signals and price action quality.

**Wick Analysis:**
```javascript
const wickAnalysis = indicators.wickAnalysis;
// Returns:
{
  upperWickDominance: 15.2,     // Upper wick as % of range
  lowerWickDominance: 65.8,      // Lower wick as % of range
  bodyDominance: 19.0,           // Body as % of range
  exhaustionSignal: "LOWER_WICK_REJECTION",  // Exhaustion type
  upperWickSize: 125.50,         // Absolute upper wick size
  lowerWickSize: 542.30,         // Absolute lower wick size
  bodySize: 157.20,              // Absolute body size
  range: 825.00,                 // Total candle range
  wickDominance: {               // Enhanced analysis
    dominantWick: "LOWER",
    wickRatio: 4.32,
    ...
  },
  bodyStrength: {                // Body strength analysis
    bodyStrength: 19.0,
    bodyStrengthCategory: "WEAK",
    ...
  },
  exhaustionSignals: {           // Exhaustion detection
    exhaustionSignal: "LOWER_WICK_REJECTION",
    exhaustionType: "BULLISH",
    confidence: 0.85
  }
}
```

**Exhaustion Signals:**
- **LOWER_WICK_REJECTION** - Long lower wick indicates bullish exhaustion (selling rejected)
- **UPPER_WICK_REJECTION** - Long upper wick indicates bearish exhaustion (buying rejected)
- **DOUBLE_WICK_INDECISION** - Long wicks on both sides indicate indecision
- **NONE** - No exhaustion signal

**Usage in Strategy:**
- Exhaustion signals help identify potential reversal points
- Used for entry timing and stop-loss placement
- Can validate or invalidate trade setups

---

### 4. Trend Strength (ADX)

Measures trend strength using Average Directional Index (ADX).

**ADX Interpretation:**
- **ADX < 20**: Weak trend (trending sideways)
- **ADX 20-25**: Moderate trend
- **ADX 25-40**: Strong trend
- **ADX ≥ 40**: Very strong trend

**Usage:**
```javascript
const trendStrength = indicators.trendStrength;
// Returns:
{
  adx: 28.5,                     // ADX value
  strong: true,                  // ADX ≥ 25
  weak: false,                   // ADX < 25
  veryStrong: false,             // ADX ≥ 40
  category: "STRONG"             // Category string
}
```

**Integration with Strategy:**
- **Weak trend** (ADX < 25): -10 to -15% confidence penalty
- **Very strong trend** (ADX ≥ 40): +3% confidence bonus
- Filters out trades in weak/choppy markets

---

## JSON Schema Extensions

### Timeframe Object

Each timeframe now includes:

```json
{
  "4h": {
    "indicators": {
      "candlestickPatterns": {
        "current": "HAMMER",
        "confidence": 0.75,
        "bullish": true,
        "bearish": false,
        "patterns": ["HAMMER"]
      },
      "wickAnalysis": {
        "upperWickDominance": 15.2,
        "lowerWickDominance": 65.8,
        "exhaustionSignal": "LOWER_WICK_REJECTION",
        ...
      },
      "trendStrength": {
        "adx": 28.5,
        "strong": true,
        "weak": false,
        "category": "STRONG"
      },
      "rsi": {
        "value": 45.2,
        "overbought": false,
        "oversold": false
      }
    }
  }
}
```

### Root Level (Analyze Endpoint)

```json
{
  "momentum": {
    "alignment": "BULLISH",
    "alignmentScore": 75.5,
    "bullishCount": 4,
    "bearishCount": 1,
    "score": {
      "score": 82.5,
      "consensusRatio": 0.8
    },
    "bias": {
      "bias": "BULLISH",
      "strength": 75.5
    }
  }
}
```

---

## Strategy Integration

### Confidence Calculation Enhancements

The strategy engine now incorporates chart-based signals:

1. **Pattern Bonuses:**
   - Strong bullish pattern (confidence > 0.7) on long: +5-15%
   - Strong bearish pattern (confidence > 0.7) on short: +5-15%
   - Contradictory pattern: -5-10%

2. **Momentum Alignment:**
   - Aligned momentum (score ≥ 60): +5-10%
   - Contradictory momentum: -5-8%

3. **ADX Filter:**
   - Weak trend (ADX < 25): -10 to -15%
   - Very strong trend (ADX ≥ 40): +3%

### Example Confidence Calculation

```
Base Confidence: 75%
+ Pattern Bonus (HAMMER, 0.85): +12%
+ Momentum Alignment (BULLISH, 75): +8%
+ ADX (Strong, 28.5): 0%
= Final Confidence: 95% (capped at 95% in AGGRESSIVE mode)
```

---

## Best Practices

1. **Pattern Reliability:**
   - Higher confidence patterns (> 0.8) are more reliable
   - Multi-candle patterns (Morning Star, Three White Soldiers) are stronger
   - Consider pattern context (trend, support/resistance)

2. **Momentum Alignment:**
   - Look for 60%+ alignment across timeframes
   - Higher consensus ratio = stronger signal
   - Avoid trades with conflicting momentum

3. **Trend Strength:**
   - Avoid trading when ADX < 20 (choppy market)
   - Prefer ADX 25-40 for strong trends
   - Very strong trends (ADX ≥ 40) may be overextended

4. **Wick Analysis:**
   - Long wicks indicate rejection/exhaustion
   - Use exhaustion signals for entry timing
   - Combine with pattern detection for confirmation

---

## Performance Impact

- **Pattern Detection:** < 5ms per timeframe
- **Momentum Alignment:** < 10ms (cross-timeframe analysis)
- **Wick Analysis:** < 2ms per timeframe
- **ADX Calculation:** < 3ms per timeframe
- **Total Overhead:** < 20ms per symbol analysis

---

## Future Enhancements

- Pattern reliability scoring based on historical performance
- Divergence detection (price vs momentum)
- Pattern combinations (multiple patterns on same timeframe)
- Machine learning-based pattern classification

---

**Last Updated:** 2024-12-06

