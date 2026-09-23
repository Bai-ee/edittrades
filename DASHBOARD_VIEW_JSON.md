# 📊 Dashboard View JSON

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## Overview

The **Dashboard View** JSON format captures **exactly what you see** on the dashboard UI - no more, no less. It's a compact, human-readable snapshot of your analysis that automatically grows as we add new features.

## 🎯 Key Features

- ✅ **Always in sync** - Matches what's displayed on screen
- ✅ **Compact format** - ~2-3KB (smaller than full API, larger than LLM-optimized)
- ✅ **Future-proof** - Automatically includes new fields as we enhance the tool
- ✅ **Multi-timeframe** - Includes all analyzed timeframes (4h, 1h, 15m, 5m)
- ✅ **Complete picture** - Trade signal + detailed indicator data for each timeframe

## 📋 How to Use

### From Main Dashboard
1. Analyze any symbol (e.g., BTCUSDT)
2. Click **📊 View** button next to the symbol
3. JSON is copied to clipboard!

### From Scanner
1. Run a market scan
2. Click **📊** button on any opportunity row
3. Dashboard view JSON is copied!

## 🆚 Comparison with Other Formats

| Format | Size | Timeframes | Use Case |
|--------|------|------------|----------|
| **📋 Full JSON** | ~192KB | All (4h, 1h, 15m, 5m) + raw data | Complete data export, debugging |
| **🤖 LLM Compact** | ~470 bytes | 4h, 1h only | ChatGPT/LLM analysis (token-optimized) |
| **📊 Dashboard View** | ~2-3KB | All displayed (4h, 1h, 15m, 5m) | Sharing analysis, documentation, review |

## 📊 Example Output

### Valid Trade Signal
```json
{
  "symbol": "BTCUSDT",
  "currentPrice": 90690.3,
  "priceChange24h": 2.45,
  "signal": {
    "valid": true,
    "direction": "long",
    "confidence": 78,
    "reason": "4h uptrend confirmed, 1h aligned, price near 21 EMA entry zone, Stoch RSI curling up from oversold",
    "entryZone": {
      "min": 89500,
      "max": 90000
    },
    "stopLoss": 88200,
    "targets": {
      "tp1": 91800,
      "tp2": 93600
    }
  },
  "timeframes": {
    "4h": {
      "currentPrice": 90690.3,
      "ema21": 87927.62,
      "ema200": 97806.04,
      "stochRSI": {
        "k": 25.5,
        "d": 22.3,
        "condition": "OVERSOLD"
      },
      "pullback": {
        "state": "ENTRY_ZONE",
        "distanceFrom21EMA": 3.14
      },
      "trend": "UPTREND",
      "swingHigh": 92000.0,
      "swingLow": 85250.0
    },
    "1h": {
      "currentPrice": 90690.3,
      "ema21": 89200.0,
      "ema200": 88500.0,
      "stochRSI": {
        "k": 45.2,
        "d": 43.1,
        "condition": "NEUTRAL"
      },
      "pullback": {
        "state": "RETRACING",
        "distanceFrom21EMA": 1.67
      },
      "trend": "UPTREND",
      "swingHigh": 91500.0,
      "swingLow": 88900.0
    },
    "15m": {
      "currentPrice": 90690.3,
      "ema21": 90100.0,
      "ema200": 89800.0,
      "stochRSI": {
        "k": 62.5,
        "d": 58.3,
        "condition": "BULLISH"
      },
      "pullback": {
        "state": "ENTRY_ZONE",
        "distanceFrom21EMA": 0.65
      },
      "trend": "UPTREND",
      "swingHigh": 91000.0,
      "swingLow": 89500.0
    },
    "5m": {
      "currentPrice": 90690.3,
      "ema21": 90650.0,
      "ema200": 90400.0,
      "stochRSI": {
        "k": 72.1,
        "d": 68.5,
        "condition": "BULLISH"
      },
      "pullback": {
        "state": "ENTRY_ZONE",
        "distanceFrom21EMA": 0.04
      },
      "trend": "UPTREND",
      "swingHigh": 90800.0,
      "swingLow": 90200.0
    }
  },
  "timestamp": "2025-11-27T10:30:00.000Z"
}
```

### No Trade Signal
```json
{
  "symbol": "ETHUSDT",
  "currentPrice": 3250.5,
  "priceChange24h": -1.2,
  "signal": {
    "valid": false,
    "direction": "NO_TRADE",
    "confidence": 0,
    "reason": "4h trend is flat - no trade"
  },
  "timeframes": {
    "4h": {
      "currentPrice": 3250.5,
      "ema21": 3245.0,
      "ema200": 3240.0,
      "stochRSI": {
        "k": 50.5,
        "d": 48.3,
        "condition": "NEUTRAL"
      },
      "pullback": {
        "state": "UNKNOWN",
        "distanceFrom21EMA": 0.17
      },
      "trend": "FLAT",
      "swingHigh": 3300.0,
      "swingLow": 3200.0
    },
    "1h": {
      "currentPrice": 3250.5,
      "ema21": 3248.0,
      "ema200": 3245.0,
      "stochRSI": {
        "k": 52.1,
        "d": 51.8,
        "condition": "NEUTRAL"
      },
      "pullback": {
        "state": "UNKNOWN",
        "distanceFrom21EMA": 0.08
      },
      "trend": "FLAT",
      "swingHigh": 3270.0,
      "swingLow": 3230.0
    }
  },
  "timestamp": "2025-11-27T10:30:00.000Z"
}
```

## 📖 Field Reference

### Root Level
| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | Trading pair (e.g., "BTCUSDT") |
| `currentPrice` | number | Current market price |
| `priceChange24h` | number | 24-hour price change percentage |
| `signal` | object | 4H Set & Forget trade signal |
| `timeframes` | object | Multi-timeframe analysis |
| `timestamp` | string | ISO 8601 timestamp |

### Signal Object
| Field | Type | Always Present | Description |
|-------|------|----------------|-------------|
| `valid` | boolean | ✅ | Is this a valid trade setup? |
| `direction` | string | ✅ | "long", "short", or "NO_TRADE" |
| `confidence` | number | ✅ | 0-100 (percentage) |
| `reason` | string | ✅ | Human-readable explanation |
| `entryZone` | object | ⚠️ Only if valid | Entry zone min/max prices |
| `stopLoss` | number | ⚠️ Only if valid | Stop loss price level |
| `targets` | object | ⚠️ Only if valid | TP1 and TP2 price levels |

### Timeframe Object (per interval: 4h, 1h, 15m, 5m)
| Field | Type | Description |
|-------|------|-------------|
| `currentPrice` | number | Current price on this timeframe |
| `ema21` | number | 21-period EMA |
| `ema200` | number | 200-period EMA (may be null) |
| `stochRSI.k` | number | Stochastic RSI %K (0-100) |
| `stochRSI.d` | number | Stochastic RSI %D (0-100) |
| `stochRSI.condition` | string | "OVERBOUGHT", "OVERSOLD", "BULLISH", "BEARISH", "NEUTRAL" |
| `pullback.state` | string | "ENTRY_ZONE", "OVEREXTENDED", "RETRACING", "UNKNOWN" |
| `pullback.distanceFrom21EMA` | number | Distance from 21 EMA in percentage |
| `trend` | string | "UPTREND", "DOWNTREND", "FLAT" |
| `swingHigh` | number | Recent swing high (may be null) |
| `swingLow` | number | Recent swing low (may be null) |

## 🔄 Future-Proof Design

When we add new indicators or data to the dashboard (e.g., volume, RSI, MACD), they will **automatically** appear in the Dashboard View JSON because it's extracted directly from the analysis data shown on screen.

### Example: If we add Volume and RSI
```json
{
  "timeframes": {
    "4h": {
      "currentPrice": 90690.3,
      "ema21": 87927.62,
      "ema200": 97806.04,
      "stochRSI": { ... },
      "pullback": { ... },
      "trend": "UPTREND",
      "swingHigh": 92000.0,
      "swingLow": 85250.0,
      "volume": 1234567890,     // ← NEW: Auto-included
      "rsi": 62.5                // ← NEW: Auto-included
    }
  }
}
```

## 💡 Use Cases

1. **Sharing Analysis** - Send compact analysis to trading partners
2. **Documentation** - Save trade setups for review
3. **Historical Record** - Log analyzed setups with timestamps
4. **Review & Learning** - Compare past signals with actual outcomes
5. **Integration** - Feed into custom tools or spreadsheets
6. **Quick Reference** - Paste into notes or trading journals

## 🚀 Quick Example

1. Open: https://snapshottradingview.vercel.app/
2. Analyze BTCUSDT
3. Click **📊 View**
4. Paste into your notes/journal/trading log

That's it! You now have a complete, compact snapshot of your analysis.

