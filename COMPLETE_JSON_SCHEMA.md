# 📋 Complete JSON Schema - Final Structure

## Overview

This document describes the **complete** JSON structure returned by `/api/analyze` and `/api/indicators` endpoints, including all fields for professional-grade trading analysis.

---

## 🎯 Top-Level Structure

```json
{
  "symbol": "BTCUSDT",
  "currentPrice": 91121.7,              // For /api/analyze
  "price": 91121.7,                     // For compact endpoints
  "priceChange24h": 0.65,
  "change24h": 0.65,                    // Alias
  "signal": { ... },                    // Only in /api/analyze
  "tradeSignal": { ... },               // Alias for signal
  "timeframes": { ... },                // Clean format in /api/indicators
  "analysis": { ... },                  // Full format in /api/analyze
  "timestamp": "2025-11-27T04:32:05.017Z"
}
```

---

## 📊 Signal Object (Trade Decision)

**Endpoint:** `/api/analyze` only

```json
"signal": {
  "valid": true,
  "direction": "short",                 // "long" | "short" | "flat" | "NO_TRADE"
  "confidence": 0.82,                   // 0-1 scale
  "reason": "4h downtrend + 1h agrees, stoch down, candle rejection",
  "reason_summary": "Short setup with high confidence",
  "entryZone": {
    "min": 90700,
    "max": 90900
  },
  "stopLoss": 91250,
  "targets": {
    "tp1": 89500,
    "tp2": 88700
  },
  "riskReward": {
    "tp1RR": 1.3,
    "tp2RR": 2.4
  },
  "ema21": 89574.3,
  "ema200": 88829.5,
  "currentPrice": 91121.7,
  "trend": {
    "4h": "DOWNTREND",
    "1h": "DOWNTREND"
  },
  "stoch": {
    "4h": { "zone": "BEARISH", "curl": "down" },
    "1h": { "zone": "BEARISH", "curl": "down" }
  },
  "timestamp": "2025-11-27T04:32:05.017Z"
}
```

---

## 📈 Complete Timeframe Object

Each timeframe (4h, 1h, 15m, 5m) contains:

```json
"4h": {
  // A. Trend & EMA Structure
  "trend": "UPTREND",
  "ema21": 89574.3,
  "ema200": 88829.5,
  "distanceFrom21EMA": -0.42,           // ADDED at top level for easy access
  
  // B. Stochastic RSI
  "stoch": {
    "k": 32.8,
    "d": 41.2,
    "condition": "BEARISH"
  },
  
  // C. Pullback State
  "pullback": {
    "state": "ENTRY_ZONE",
    "distanceFrom21EMA": -0.42
  },
  
  // D. Swing Structure
  "swingHigh": 91874,
  "swingLow": 86299.5,
  
  // E. Candle Structure (DETAILED)
  "candle": {
    "direction": "bull",                // "bull" | "bear" | "doji"
    "bodyPct": 46.48,                   // body size as % of total range (0-100)
    "upperWickPct": 22.57,              // upper wick as % of total range
    "lowerWickPct": 30.94,              // lower wick as % of total range
    "closeRelativeToRange": 77.43,     // 0 = at low, 100 = at high
    "closeAboveEma21": true,
    "closeBelowEma21": false,
    "range": {
      "open": 91133.2,
      "high": 91329.6,
      "low": 91045.2,
      "close": 91265.4
    }
  },
  
  // F. Price Action Patterns
  "priceAction": {
    "rejectionUp": false,               // long upper wick rejection
    "rejectionDown": false,             // long lower wick rejection
    "engulfingBull": false,             // bullish engulfing pattern
    "engulfingBear": false,             // bearish engulfing pattern
    "insideBar": true                   // inside bar pattern
  },
  
  // G. Support/Resistance Levels (4h & 1h only)
  "levels": {
    "nearestSupport": 85250,
    "nearestResistance": 91874,
    "distanceToSupportPct": 6.59,
    "distanceToResistancePct": 0.67,
    "atSupport": false,
    "atResistance": false,
    "brokeResistanceOnClose": false,
    "brokeSupportOnClose": false
  },
  
  // H. VWAP (5m, 15m, 1h only)
  "vwap": {
    "value": 90250.5,
    "distancePct": 0.85,
    "above": false,
    "below": true,
    "bias": "short",
    "atVwap": false,
    "reversionZone": false
  },
  "vwapPositioning": {
    "trappedLongsLikely": true,
    "trappedShortsLikely": false
  },
  
  // I. Bollinger Bands (4h, 1h, 15m)
  "bollinger": {
    "mid": 87963.14,
    "upper": 90938.48,
    "lower": 84987.81,
    "bandWidthPct": 6.76,
    "squeeze": false,
    "pricePosPct": 100
  },
  
  // J. Volatility (ATR) - All timeframes
  "volatility": {
    "atr": 1462.94,
    "atrPct": 1.6,
    "volatilityState": "NORMAL"         // LOW | NORMAL | HIGH
  },
  
  // K. Moving Averages & Stack (4h & 1h only)
  "movingAverages": {
    "ema21": 88270.98,
    "ema50": 88871.00,
    "ema200": 97745.24
  },
  "maStructure": {
    "bullStack": false,
    "bearStack": true,
    "flatStack": false
  },
  
  // L. Volume Analysis (if available)
  "volume": {
    "current": 10329,
    "avg20": 8820,
    "trend": "increasing"               // increasing | decreasing | neutral
  },
  
  // M. Confluence Scores
  "confluence": {
    "trendScore": 0.80,
    "stochScore": 0.70,
    "structureScore": 0.65,
    "maScore": 0.75,
    "vwapScore": 0.60
  },
  
  // N. Recent Candles (5m only)
  "recentCandles": [
    { "open": 90400, "high": 90700, "low": 90350, "close": 90680 },
    { "open": 90250, "high": 90500, "low": 90180, "close": 90400 },
    { "open": 90000, "high": 90300, "low": 89950, "close": 90250 }
  ]
}
```

---

## ✅ Confirmation Status

| Category | Status | Notes |
|----------|--------|-------|
| **Top-Level Fields** | ✅ Complete | symbol, price, change24h, signal, timeframes, timestamp |
| **Signal Object** | ✅ Complete | valid, direction, confidence, entryZone, SL, TP, RR, reason |
| **Trend & EMAs** | ✅ Complete | trend, ema21, ema200, distanceFrom21EMA |
| **Stoch RSI** | ✅ Complete | k, d, condition |
| **Pullback** | ✅ Complete | state, distanceFrom21EMA |
| **Swings** | ✅ Complete | swingHigh, swingLow |
| **Candle Structure** | ✅ Complete | direction, bodyPct, wickPct, closeRelativeToRange, range |
| **Price Action** | ✅ Complete | rejection, engulfing, insideBar |
| **Levels (S/R)** | ✅ Complete | nearestSupport/Resistance, at/broke flags |
| **VWAP** | ✅ Complete | value, distancePct, bias, positioning |
| **Bollinger** | ✅ Complete | mid, upper, lower, squeeze, pricePosPct |
| **Volatility (ATR)** | ✅ Complete | atr, atrPct, volatilityState |
| **MA Stack** | ✅ Complete | ema21/50/200, bullStack/bearStack/flatStack |
| **Volume** | ✅ Complete | current, avg20, trend |
| **Confluence** | ✅ Complete | trendScore, stochScore, structureScore, maScore, vwapScore |
| **Recent Candles** | ✅ Complete | 5m only, last 5 candles |

---

## 📊 Field Availability Matrix

| Field Category | 4h | 1h | 15m | 5m |
|----------------|----|----|-----|-----|
| **Basic** |
| trend, price, EMAs | ✅ | ✅ | ✅ | ✅ |
| stoch, pullback | ✅ | ✅ | ✅ | ✅ |
| swings | ✅ | ✅ | ✅ | ✅ |
| **Candle & PA** |
| candle structure | ✅ | ✅ | ✅ | ✅ |
| price action | ✅ | ✅ | ✅ | ✅ |
| **Advanced** |
| levels (S/R) | ✅ | ✅ | ❌ | ❌ |
| VWAP | ❌ | ✅ | ✅ | ✅ |
| bollinger | ✅ | ✅ | ✅ | ❌ |
| MA stack | ✅ | ✅ | ❌ | ❌ |
| volatility (ATR) | ✅ | ✅ | ✅ | ✅ |
| volume | ✅ | ✅ | ✅ | ✅ |
| confluence | ✅ | ✅ | ✅ | ✅ |
| recentCandles | ❌ | ❌ | ❌ | ✅ |

---

## 🚀 Live Examples

### Get Complete Analysis
```bash
curl "https://snapshottradingview.vercel.app/api/analyze/BTCUSDT?intervals=4h,1h,15m,5m"
```

### Get Specific Timeframe
```bash
curl "https://snapshottradingview.vercel.app/api/indicators/BTCUSDT?intervals=4h" | jq '.timeframes."4h"'
```

### Check Confluence Scores
```bash
curl "https://snapshottradingview.vercel.app/api/indicators/BTCUSDT?intervals=4h" | jq '.timeframes."4h".confluence'
```

---

## ⚠️ Known Limitations

### Volume Data
- **Status**: ✅ Implemented
- **Note**: Volume data depends on exchange API. If volume not provided by Kraken, fields will be `null` or omitted.

### VWAP on 4h
- **Status**: ⚠️ Not included by design
- **Reason**: VWAP is an intraday indicator (resets daily). On 4h with many days of data, it's less meaningful.
- **Recommendation**: Use 1h, 15m, 5m VWAP instead
- **Alternative**: Can add if you want session/day anchored VWAP

### Confluence Scores
- **Status**: ✅ Implemented
- **Weights**: 
  - Trend: 30%
  - Stoch: 20%
  - Structure: 25%
  - MA: 15%
  - VWAP: 10%

---

## 🎯 Suggested Thresholds

### VWAP
- `atVwap`: |distance| < 0.2%
- `reversionZone`: |distance| > 2.0%
- `trappedLongs`: distance < -0.5% + DOWNTREND
- `trappedShorts`: distance > 0.5% + UPTREND

### ATR (Volatility)
- LOW: atrPct < 0.5%
- NORMAL: 0.5% ≤ atrPct ≤ 2.0%
- HIGH: atrPct > 2.0%

### Bollinger Bands
- Squeeze: bandWidthPct < 2.0%
- Oversold: pricePosPct < 20
- Overbought: pricePosPct > 80

### Price Action Detection
- Rejection: Wick > 50% of range, body < 30%
- Engulfing: Current candle fully engulfs previous
- Inside Bar: Current completely within previous range

### Confluence Scoring
- **High Confidence**: Overall score > 0.75
- **Medium**: 0.55 - 0.75
- **Low**: < 0.55

---

## 📚 Related Documentation

- `ENRICHED_SCHEMA.md` - Candle analysis details
- `ADVANCED_INDICATORS_GUIDE.md` - VWAP, ATR, Bollinger, MA Stack
- `API_QUICK_REFERENCE.md` - Quick API reference
- `README.md` - Project overview

