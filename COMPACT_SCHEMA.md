# Compact API Schema for LLM Analysis

## Purpose
Streamlined JSON response optimized for ChatGPT/LLM ingestion. Removes verbose data while keeping all essential trading information.

## Endpoint
```
GET /api/analyze-compact/BTCUSDT
```

## Response Structure

### ✅ **Valid Trade Signal Example (Long)**
```json
{
  "symbol": "BTCUSDT",
  "price": 90690.30,
  "change24h": 2.45,
  "signal": {
    "valid": true,
    "direction": "long",
    "confidence": 78,
    "reason": "4h uptrend confirmed, 1h aligned, price near 21 EMA entry zone, Stoch RSI curling up from oversold",
    "entry": {
      "min": 89500,
      "max": 90000
    },
    "stopLoss": 88200,
    "targets": {
      "tp1": 91800,
      "tp2": 93600
    },
    "riskReward": "1:2.31"
  },
  "timeframes": {
    "4h": {
      "trend": "UPTREND",
      "ema21": 87927.62,
      "ema200": 85000.50,
      "stoch": {
        "zone": "OVERSOLD",
        "k": 25.5,
        "d": 22.3
      },
      "pullback": "ENTRY_ZONE",
      "swingHigh": 92000.00,
      "swingLow": 85250.00
    },
    "1h": {
      "trend": "UPTREND",
      "ema21": 89200.00,
      "stoch": {
        "zone": "NEUTRAL",
        "k": 45.2
      },
      "pullback": "RETRACING"
    }
  },
  "timestamp": "2025-11-27T10:30:00.000Z"
}
```

### ❌ **No Trade Signal Example**
```json
{
  "symbol": "ETHUSDT",
  "price": 3250.50,
  "change24h": -1.20,
  "signal": {
    "valid": false,
    "direction": "NO_TRADE",
    "confidence": 0,
    "reason": "4h trend is FLAT. Need clear uptrend or downtrend for valid setup"
  },
  "timeframes": {
    "4h": {
      "trend": "FLAT",
      "ema21": 3245.00,
      "ema200": 3240.00,
      "stoch": {
        "zone": "NEUTRAL",
        "k": 50.5,
        "d": 48.3
      },
      "pullback": "UNKNOWN",
      "swingHigh": 3300.00,
      "swingLow": 3200.00
    },
    "1h": {
      "trend": "FLAT",
      "ema21": 3248.00,
      "stoch": {
        "zone": "NEUTRAL",
        "k": 52.1
      },
      "pullback": "UNKNOWN"
    }
  },
  "timestamp": "2025-11-27T10:30:00.000Z"
}
```

---

## Field Descriptions

### Root Level
| Field | Type | Description |
|-------|------|-------------|
| `symbol` | string | Trading pair (e.g., "BTCUSDT") |
| `price` | number | Current market price |
| `change24h` | number | 24-hour price change percentage |
| `signal` | object | Trade signal and setup details |
| `timeframes` | object | Multi-timeframe analysis (4h, 1h) |
| `timestamp` | string | ISO 8601 timestamp |

### Signal Object
| Field | Type | Always Present | Description |
|-------|------|----------------|-------------|
| `valid` | boolean | ✅ | Is this a valid trade setup? |
| `direction` | string | ✅ | "long", "short", or "NO_TRADE" |
| `confidence` | number | ✅ | 0-100 (percentage) |
| `reason` | string | ✅ | Human-readable explanation |
| `entry` | object | ⚠️ Only if valid | Entry zone min/max |
| `stopLoss` | number | ⚠️ Only if valid | Stop loss price level |
| `targets` | object | ⚠️ Only if valid | Take profit levels (tp1, tp2) |
| `riskReward` | string | ⚠️ Only if valid | Risk/reward ratio (e.g., "1:2.5") |

### Timeframe Object (4h, 1h)
| Field | Type | Description |
|-------|------|-------------|
| `trend` | string | "UPTREND", "DOWNTREND", or "FLAT" |
| `ema21` | number | 21-period EMA price level |
| `ema200` | number | 200-period EMA (4h only, may be null) |
| `stoch.zone` | string | Stochastic RSI condition |
| `stoch.k` | number | Stoch %K value (0-100) |
| `stoch.d` | number | Stoch %D value (4h only) |
| `pullback` | string | "ENTRY_ZONE", "OVEREXTENDED", "RETRACING", "UNKNOWN" |
| `swingHigh` | number | Recent swing high (4h only) |
| `swingLow` | number | Recent swing low (4h only) |

---

## Key Differences from Full API

**Removed:**
- Raw candlestick data (OHLCV arrays)
- Detailed indicator calculations
- 15m and 5m timeframes (kept 4h and 1h)
- Verbose nested objects
- Debug information

**Kept:**
- All essential trading decision data
- Clear signal validity
- Complete entry/exit levels
- Key trend and indicator states
- Concise explanation text

**Size Reduction:** ~95% smaller (from ~50KB to ~2KB)

---

## Usage with ChatGPT

### Example Prompt:
```
Analyze this trading signal and tell me if I should take this trade:

[paste compact JSON here]

Consider:
1. Is the signal valid and high confidence?
2. Are the risk/reward ratios favorable?
3. Is there multi-timeframe alignment?
4. What are the key risks?
```

### Example cURL:
```bash
curl https://your-app.vercel.app/api/analyze-compact/BTCUSDT
```

---

## Confidence Levels
- **75-100%**: 🟢 HIGH - Strong setup, all criteria aligned
- **55-74%**: 🟡 MEDIUM - Decent setup, some criteria met
- **0-54%**: 🔴 LOW - Weak setup or NO_TRADE

## Trend States
- **UPTREND**: Price above 21 EMA, 21 EMA above 200 EMA (or trending up)
- **DOWNTREND**: Price below 21 EMA, 21 EMA below 200 EMA (or trending down)
- **FLAT**: Sideways price action, unclear direction

## Pullback States
- **ENTRY_ZONE**: Price within ideal entry range near 21 EMA
- **OVEREXTENDED**: Price too far from 21 EMA (wait for pullback)
- **RETRACING**: Price pulling back toward 21 EMA
- **UNKNOWN**: Unclear pullback state

