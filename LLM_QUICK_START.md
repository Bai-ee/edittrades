# 🤖 LLM Quick Start - Compact API for ChatGPT

## ⚡ TL;DR

Use this endpoint to get **ChatGPT-friendly** trading signals:
```
https://snapshottradingview-inijkyyyt-baiees-projects.vercel.app/api/analyze-compact/BTCUSDT
```

**Size:** 470 bytes instead of 192KB (**99.75% smaller** 🎉)

---

## 🔗 Quick Copy Buttons in Dashboard

1. Open dashboard: https://snapshottradingview-inijkyyyt-baiees-projects.vercel.app/
2. Analyze any symbol (e.g., BTCUSDT)
3. Click **🤖 LLM** button to copy compact JSON

---

## 📋 Example Compact Response

```json
{
  "symbol": "BTCUSDT",
  "price": 91173.10,
  "change24h": 0.70,
  "signal": {
    "valid": false,
    "direction": "flat",
    "confidence": 0,
    "reason": "4h trend is flat - no trade"
  },
  "timeframes": {
    "4h": {
      "trend": "FLAT",
      "ema21": 87975.17,
      "ema200": 97811.24,
      "stoch": {
        "zone": "BULLISH",
        "k": 100.0,
        "d": 75.1
      },
      "pullback": "OVEREXTENDED",
      "swingHigh": 91874.00,
      "swingLow": 85250.00
    },
    "1h": {
      "trend": "UPTREND",
      "ema21": 89423.19,
      "stoch": {
        "zone": "OVERBOUGHT",
        "k": 97.2
      },
      "pullback": "RETRACING"
    }
  },
  "timestamp": "2025-11-27T03:38:09.312Z"
}
```

---

## 💬 ChatGPT Prompt Template

### Option 1: Simple
```
Analyze this crypto trading signal and tell me if I should take the trade:

[paste compact JSON here]
```

### Option 2: Detailed
```
I received this trading signal from my 4H strategy system. Please analyze:

[paste compact JSON here]

Questions:
1. Is this a valid trade setup?
2. What's the confidence level and what does it mean?
3. Are there any red flags?
4. What's the risk/reward ratio?
5. Should I take this trade?
```

### Option 3: Multiple Symbols
```
Compare these trading opportunities and rank them:

Symbol 1: BTCUSDT
[paste compact JSON]

Symbol 2: ETHUSDT
[paste compact JSON]

Symbol 3: SOLUSDT
[paste compact JSON]

Which one has the best setup and why?
```

---

## 🎯 What's Included (vs Full API)

| Data | Full API | Compact API |
|------|----------|-------------|
| Trade signal (valid/invalid) | ✅ | ✅ |
| Direction (long/short/no trade) | ✅ | ✅ |
| Confidence score | ✅ | ✅ |
| Entry zone | ✅ | ✅ |
| Stop loss & targets | ✅ | ✅ |
| Risk/reward ratio | ✅ | ✅ |
| 4H trend & indicators | ✅ | ✅ |
| 1H trend & indicators | ✅ | ✅ |
| 15m timeframe | ✅ | ❌ |
| 5m timeframe | ✅ | ❌ |
| Raw candlestick data | ✅ | ❌ |
| Full indicator calculations | ✅ | ❌ |
| Debug information | ✅ | ❌ |

**Removed:** Lower timeframes (15m, 5m), raw OHLCV data, verbose nested objects
**Kept:** All essential trading decision data

---

## 🔧 API Endpoints

### Production (Vercel)
```bash
# Single symbol - compact
curl "https://snapshottradingview-inijkyyyt-baiees-projects.vercel.app/api/analyze-compact/BTCUSDT"

# Single symbol - full
curl "https://snapshottradingview-inijkyyyt-baiees-projects.vercel.app/api/analyze/BTCUSDT"

# Scanner
curl "https://snapshottradingview-inijkyyyt-baiees-projects.vercel.app/api/scan?minConfidence=0.6"
```

### Local Development
```bash
# Start local server
npm start
# or
vercel dev

# Then use
curl "http://localhost:3000/api/analyze-compact/BTCUSDT"
```

---

## 📊 Field Reference

### Signal Object
- `valid`: boolean - Is this a tradeable setup?
- `direction`: "long" | "short" | "flat" | "NO_TRADE"
- `confidence`: 0-100 (percentage)
  - **75-100**: 🟢 HIGH - Strong setup
  - **55-74**: 🟡 MEDIUM - Decent setup
  - **0-54**: 🔴 LOW or NO_TRADE
- `reason`: Human-readable explanation
- `entry`: Entry zone (min/max) - only if valid
- `stopLoss`: Stop loss price - only if valid
- `targets`: TP1 and TP2 - only if valid
- `riskReward`: Format "1:X.XX" (e.g., "1:2.31")

### Timeframe Object
- `trend`: "UPTREND" | "DOWNTREND" | "FLAT"
- `ema21`: 21-period EMA price level
- `ema200`: 200-period EMA (4h only)
- `stoch.zone`: Stochastic RSI condition
  - "OVERSOLD", "OVERBOUGHT", "BULLISH", "BEARISH", "NEUTRAL"
- `stoch.k`: Stoch %K value (0-100)
- `stoch.d`: Stoch %D value (0-100, 4h only)
- `pullback`: "ENTRY_ZONE", "OVEREXTENDED", "RETRACING", "UNKNOWN"
- `swingHigh`: Recent swing high (4h only)
- `swingLow`: Recent swing low (4h only)

---

## 🎓 Trading Strategy Rules (for ChatGPT context)

This is a **4H Set & Forget** system with these core rules:

1. **Primary Timeframe**: 4-hour must show clear trend (not flat)
2. **Entry Zone**: Price should be near 21 EMA for optimal entry
3. **Confirmation**: 1H trend should align with 4H
4. **Momentum**: Stochastic RSI should show curl in trade direction
5. **Risk Management**: Stop loss beyond swing points, targets at 1:1 and 1:2 RR
6. **Confidence Scoring**: 
   - 4H trend clarity: 25%
   - MTF alignment: 25%
   - Entry zone proximity: 25%
   - Stoch RSI setup: 25%

---

## 📖 Full Documentation

- **Complete Schema**: [COMPACT_SCHEMA.md](./COMPACT_SCHEMA.md)
- **API Reference**: [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Strategy Details**: [README.md](./README.md)

---

## 🚀 Quick Test

```bash
# Test the compact endpoint
curl "https://snapshottradingview-inijkyyyt-baiees-projects.vercel.app/api/analyze-compact/BTCUSDT" | jq .
```

**Response time:** ~1-2 seconds  
**Data size:** ~500 bytes  
**Perfect for:** ChatGPT, Claude, LLMs, mobile apps, quick checks

