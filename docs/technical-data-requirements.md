# Technical Data Requirements Analysis

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md).
## Based on PRD: 4-Hour Trading Strategy Automation

---

## 1. PRIMARY DATA REQUIREMENTS (From External API)

### 1.1 OHLCV Candlestick Data

**Required Timeframes:**
- ✅ 4h (primary strategy timeframe)
- ✅ 1h (confirmation timeframe)
- ✅ 15m (entry timing)
- ✅ 5m (execution timing)
- ✅ 3m (micro structure)
- ✅ 1m (precision entry)

**Required Fields per Candle:**
```json
{
  "timestamp": 1700000000000,
  "open": 94250.45,
  "high": 94500.00,
  "low": 94100.00,
  "close": 94350.75,
  "volume": 1250000.50
}
```

**Required Symbols:**
- BTC (Bitcoin)
- SOL (Solana)
- ETH (Ethereum)
- BRC (BitRock - needs verification of ticker)
- Extensible for additional pairs

**Historical Depth Needed:**
- Minimum: 200 candles per timeframe (for 200 EMA calculation)
- Recommended: 500 candles (for better structure analysis)

---

## 2. CALCULATED INDICATORS (Derived from OHLCV)

### 2.1 Moving Averages
**Must Calculate:**
- 21 EMA (Exponential Moving Average) - ALL timeframes
- 200 EMA - Mandatory on 4h & 1h, optional on lower TFs

**Formula:**
```
EMA = (Close - EMA_prev) × (2 / (period + 1)) + EMA_prev
```

**Usage:**
- Trend direction determination
- Entry zone identification (21 EMA retests)
- Long/short bias decision
- Confluence validation

### 2.2 Stochastic RSI
**Required Timeframes:**
- 4h (trend health)
- 1h (structure momentum)
- 15m (entry timing)
- 5m (execution timing)

**Parameters:**
- Period: 14 (standard)
- %K line
- %D line (3-period SMA of %K)

**Thresholds:**
- Overbought: >80
- Oversold: <20

**Must Detect:**
- Direction of curl (up/down/flat)
- Crossovers (%K crosses %D)
- Divergences (optional enhancement)

### 2.3 Market Structure Analysis
**Higher Timeframe (4h & 1h):**
- Most recent swing high (lookback: 5-20 candles)
- Most recent swing low (lookback: 5-20 candles)
- Break of structure detection

**Lower Timeframe (15m, 5m, 3m):**
- Local swing points
- Micro pullback levels
- Minor support/resistance zones
- Flag pattern detection

**Algorithm Required:**
- Peak/trough detection
- Structure break validation
- Dynamic S/R level calculation

---

## 3. DERIVED MARKET CONDITIONS (Logic Layer)

### 3.1 Trend Classification
```
4h Trend:
  - UPTREND: price > 21 EMA > 200 EMA
  - DOWNTREND: price < 21 EMA < 200 EMA
  - FLAT: neither condition met
```

### 3.2 Pullback State Detection
```
States:
  1. OVEREXTENDED: price far above/below 21 EMA
  2. RETRACING: approaching 21 EMA
  3. ENTRY_ZONE: tagging 21 EMA (±0.3-0.5%)
  4. INVALIDATED: broke past 21 EMA
```

### 3.3 Candle Pattern Recognition
- Wick rejection (long wick, small body)
- Body close beyond key level
- Failed breakout detection
- Momentum shift identification

---

## 4. API EVALUATION

### ❌ Free Crypto API (freecryptoapi.com)
**Issues:**
- ❌ Only supports DAILY OHLC
- ❌ No intraday intervals (4h, 1h, 15m, 5m)
- ✅ Has spot price endpoint
- ✅ Adequate rate limits (100k/month)

**Verdict:** **CANNOT MEET REQUIREMENTS**

---

### ✅ Binance API (RECOMMENDED)
**Base URL:** `https://api.binance.com`

**Key Endpoints:**

1. **Klines (Candlestick Data)**
```
GET /api/v3/klines
Parameters:
  - symbol: BTCUSDT, SOLUSDT, ETHUSDT
  - interval: 1m, 3m, 5m, 15m, 1h, 4h
  - limit: 1-1000 (default 500)
  
Response: [
  [timestamp, open, high, low, close, volume, closeTime, ...]
]
```

2. **Ticker Price**
```
GET /api/v3/ticker/price?symbol=BTCUSDT
Response: { "symbol": "BTCUSDT", "price": "94250.45" }
```

3. **24hr Ticker Stats**
```
GET /api/v3/ticker/24hr?symbol=BTCUSDT
Response: {
  "symbol": "BTCUSDT",
  "priceChange": "1250.00",
  "priceChangePercent": "1.35",
  "lastPrice": "94250.45",
  "volume": "25000.50",
  "high": "95000.00",
  "low": "93000.00"
}
```

**Advantages:**
- ✅ ALL required timeframes supported (1m, 3m, 5m, 15m, 1h, 4h)
- ✅ High-quality, reliable data
- ✅ No API key needed for public endpoints
- ✅ Generous rate limits: 1200 requests/minute
- ✅ 99.99% uptime
- ✅ WebSocket support for real-time updates
- ✅ Well-documented and widely used

**Rate Limits:**
- Weight-based system
- 1200 weight per minute per IP
- Klines endpoint: weight = 1
- More than sufficient for our use case

**Verdict:** **PERFECT FIT** ⭐

---

### 🟡 Alternative: CoinGecko API
**Pros:**
- Free tier available
- Multiple exchanges aggregated
- Good documentation

**Cons:**
- Rate limits more restrictive (10-50 calls/min)
- OHLC endpoint less granular
- Delayed data on free tier

**Verdict:** Backup option if Binance unavailable

---

## 5. DATA CALCULATION LIBRARIES NEEDED

### For Technical Indicators:
**Option 1: tulind (Node.js)**
```javascript
npm install tulind
// Provides: EMA, Stochastic RSI, RSI, MACD, etc.
```

**Option 2: technicalindicators (JavaScript)**
```javascript
npm install technicalindicators
// Pure JS, no compilation needed
// Full TA-Lib implementation
```

**Option 3: pandas_ta (Python)**
```python
pip install pandas pandas-ta
# If using Python backend
```

### For Chart Display:
**Lightweight Charts (TradingView)**
```javascript
npm install lightweight-charts
// Official TradingView charting library
// Performant, beautiful, and free
```

---

## 6. DATA REFRESH REQUIREMENTS

### Update Frequencies:

**Critical Path (Real-time monitoring):**
- 4h candle close: Check every 4 hours
- Live price monitoring: Every 30-60 seconds
- Invalidation checks: Every 5 minutes

**On-Demand:**
- Manual "evaluate now" trigger
- Fetch latest data across all timeframes
- Re-run full analysis

**Optimized Caching:**
- Cache historical candles (rarely change)
- Only fetch latest 5-10 candles per request
- Use WebSocket for live price updates

---

## 7. DATA STORAGE REQUIREMENTS

### Temporary (In-Memory):
- Last 200 candles per timeframe
- Calculated indicators
- Current market conditions

### Persistent (Database):
- Generated trade signals
- Signal outcomes (TP/SL/Exit)
- Performance metrics
- Journal entries with auto-commentary

**Recommended DB:** 
- SQLite (simple, embedded)
- PostgreSQL (if scaling to multi-user)
- MongoDB (flexible schema for signal objects)

---

## 8. TECHNICAL ARCHITECTURE PROPOSAL

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND (React)                    │
│  - Dashboard UI                                         │
│  - TradingView Charts (lightweight-charts)              │
│  - Signal Display                                       │
│  - Manual Trigger Button                                │
└──────────────────┬──────────────────────────────────────┘
                   │ REST API / WebSocket
┌──────────────────▼──────────────────────────────────────┐
│                  BACKEND (Node.js/Express)              │
│  ┌──────────────────────────────────────────────────┐   │
│  │         Data Acquisition Service                 │   │
│  │  - Binance API client                           │   │
│  │  - Multi-timeframe data fetcher                 │   │
│  │  - WebSocket live price feed                    │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │                                    │
│  ┌──────────────────▼───────────────────────────────┐   │
│  │      Technical Analysis Engine                   │   │
│  │  - EMA calculation (21, 200)                    │   │
│  │  - Stochastic RSI                               │   │
│  │  - Market structure detection                   │   │
│  │  - Pattern recognition                          │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │                                    │
│  ┌──────────────────▼───────────────────────────────┐   │
│  │        Strategy Logic Engine                     │   │
│  │  - Trend classification                         │   │
│  │  - Setup validation (long/short)                │   │
│  │  - Confidence scoring                           │   │
│  │  - Signal generation                            │   │
│  │  - Invalidation detection                       │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │                                    │
│  ┌──────────────────▼───────────────────────────────┐   │
│  │         Scheduler & Monitoring                   │   │
│  │  - 4h interval checks                           │   │
│  │  - Real-time invalidation monitor               │   │
│  │  - Manual trigger handler                       │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │                                    │
│  ┌──────────────────▼───────────────────────────────┐   │
│  │            Database Layer                        │   │
│  │  - Trade signals storage                        │   │
│  │  - Performance tracking                         │   │
│  │  - Journal entries                              │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 9. RATE LIMIT OPTIMIZATION STRATEGY

### For Binance API:

**Initial Load (per symbol):**
- 6 timeframes × 1 request = 6 requests
- 4 symbols × 6 = 24 requests total
- Weight: 24/1200 = 2% of minute limit

**Periodic Updates:**
- Fetch only latest candles (limit=5)
- Every 5 minutes: 24 requests
- Per hour: 288 requests
- Per day: 6,912 requests
- **Well within limits!**

**Real-time Price:**
- Use WebSocket (no REST rate limit)
- Or: 1 request per symbol every 30s = 2 req/min
- Negligible impact

---

## 10. VALIDATION CHECKLIST

Before proceeding with development, confirm:

- [x] API supports all 6 required timeframes ✅ **Binance does**
- [x] Can fetch OHLCV data ✅ **Yes**
- [x] Rate limits sufficient ✅ **Yes (1200/min)**
- [x] No API key needed for basic use ✅ **Public endpoints**
- [x] Real-time data available ✅ **WebSocket**
- [x] Can calculate 21/200 EMA ✅ **Via libraries**
- [x] Can calculate Stoch RSI ✅ **Via libraries**
- [x] Can implement structure detection ✅ **Custom logic**
- [x] Supports required symbols ✅ **BTC, SOL, ETH (BRC TBD)**

---

## 11. IMPLEMENTATION PRIORITY

### Phase 1: Core Data Pipeline ✅
1. Binance API integration
2. Multi-timeframe data fetching
3. Data caching and storage
4. Basic indicator calculations (EMA, Stoch RSI)

### Phase 2: Strategy Engine
5. Trend classification logic
6. Setup validation (long/short rules)
7. Confidence scoring
8. Signal generation

### Phase 3: Automation & Monitoring
9. 4h interval scheduler
10. Real-time invalidation monitoring
11. Manual trigger endpoint

### Phase 4: Frontend & Visualization
12. React dashboard
13. TradingView charts
14. Signal display UI
15. Journal/history view

---

## 12. NEXT STEPS

✅ **API Decision:** Use **Binance API**

✅ **Tech Stack:**
- Frontend: React + Vite + Tailwind CSS
- Backend: Node.js + Express
- Charts: Lightweight Charts (TradingView)
- Indicators: `technicalindicators` library
- Database: SQLite (start simple)

✅ **Ready to Build:** All technical requirements can be fulfilled

---

## SUMMARY

| Requirement | Source | Status |
|-------------|--------|--------|
| 4h OHLCV | Binance API | ✅ |
| 1h OHLCV | Binance API | ✅ |
| 15m OHLCV | Binance API | ✅ |
| 5m OHLCV | Binance API | ✅ |
| 3m OHLCV | Binance API | ✅ |
| 1m OHLCV | Binance API | ✅ |
| 21 EMA | Calculate | ✅ |
| 200 EMA | Calculate | ✅ |
| Stoch RSI | Calculate | ✅ |
| Market Structure | Calculate | ✅ |
| Real-time Price | Binance WebSocket | ✅ |
| Rate Limits | 1200/min | ✅ |
| Cost | Free | ✅ |

**ALL REQUIREMENTS FULFILLED** 🎉

---

**Document Version:** 1.0  
**Last Updated:** Nov 25, 2025  
**Status:** Ready for Development







