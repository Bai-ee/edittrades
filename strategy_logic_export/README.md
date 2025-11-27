# Trade Signal Logic - Complete Export

This folder contains all the core files responsible for generating trade signals in the EditTrades application.

## 📁 Folder Structure

```
strategy_logic_export/
├── services/
│   ├── strategy.js          # Main 4H strategy engine
│   └── marketData.js         # OHLCV data provider (Kraken API)
├── api/
│   ├── analyze.js            # Trade signal API endpoint
│   └── indicators.js         # Technical indicators API endpoint
├── lib/
│   ├── candleFeatures.js     # Candle pattern analysis
│   ├── levels.js             # Support/resistance calculation
│   ├── volumeAnalysis.js     # Volume metrics
│   └── confluenceScoring.js  # Multi-factor scoring
├── frontend_template_logic.js # Template evaluation (4H/Swing/Scalp)
└── README.md                  # This file
```

## 📊 Signal Flow

```
User Request
    ↓
api/analyze.js (serverless endpoint)
    ↓
services/marketData.js (fetch OHLCV from Kraken)
    ↓
api/indicators.js (calculate EMAs, Stoch RSI, etc.)
    ↓
services/strategy.js (4H strategy evaluation)
    ↓
frontend_template_logic.js (template-specific evaluation)
    ↓
Trade Signal Displayed
```

## 🎯 Core Files Explained

### 1. **services/strategy.js**
**Purpose:** Main strategy engine for the 4H "Set & Forget" system

**Key Functions:**
- `evaluateStrategy(analysis, symbol)` - Main entry point
- Entry zone calculation (around 21 EMA)
- Stop loss placement (swing high/low)
- Take profit targets (1:1, 1:2 risk/reward)
- Confidence scoring (0.0 - 1.0)
- Trend detection (UPTREND/DOWNTREND/FLAT)

**Strategy Rules:**
- 4H must have clear trend (not FLAT)
- Price near 21 EMA (< 3% distance)
- Stochastic RSI alignment
- 1H confirms 4H direction
- Entry on 15m/5m pullback

### 2. **api/analyze.js**
**Purpose:** Serverless API endpoint that orchestrates the entire signal generation

**Endpoint:** `GET /api/analyze/:symbol?intervals=1M,1w,1d,4h,1h,15m,5m,1m`

**What it does:**
1. Fetches multi-timeframe OHLCV data
2. Calculates all technical indicators
3. Runs strategy engine
4. Returns comprehensive JSON with:
   - Trade direction (LONG/SHORT/NO_TRADE)
   - Entry zone, stop loss, targets
   - Confidence percentage
   - Detailed reasoning
   - All timeframe data

### 3. **api/indicators.js**
**Purpose:** Calculate all technical indicators for multiple timeframes

**Endpoint:** `GET /api/indicators?symbol=BTCUSDT&intervals=4h,1h,15m,5m`

**Indicators Calculated:**
- **EMAs:** 21, 200
- **Stochastic RSI:** %K, %D, condition
- **Swing Points:** Recent highs and lows
- **Pullback State:** ENTRY_ZONE, OVEREXTENDED, RETRACING
- **VWAP:** Current, distance %, bias
- **Bollinger Bands:** Upper, middle, lower, position
- **ATR/Volatility:** Percentage-based volatility
- **Volume:** Current, 20-period average, trend
- **Candle Features:** Body/wick ratios, rejection patterns
- **Support/Resistance:** Nearest levels, breaks

### 4. **services/marketData.js**
**Purpose:** Fetch OHLCV candlestick data from exchanges

**Data Source:** Kraken API (primary)

**Supported Timeframes:**
- 1m, 5m, 15m, 1h, 4h, 1d, 1w, 1M (monthly)

**Functions:**
- `getOHLCV(symbol, interval, limit)` - Fetch candle data
- `getMultiTimeframeOHLCV(symbol, intervals)` - Batch fetch
- Automatic retry logic
- Fallback to synthetic data if API fails

### 5. **frontend_template_logic.js**
**Purpose:** Evaluate signals based on different trading templates

**Templates:**

#### 4H Template (Set & Forget)
- **Anchor:** 4h (macro trend)
- **Confirm:** 1h (momentum)
- **Entry:** 15m, 5m (pullback)
- **Min Confidence:** 70%
- **Risk/Reward:** 1:1, 1:2
- **Max Leverage:** 50x
- **Trades/Day:** 1

#### Swing Template (Daily/4H)
- **Anchor:** 1d, 4h (higher timeframe trend)
- **Confirm:** 1h
- **Entry:** 15m
- **Min Confidence:** 75%
- **Risk/Reward:** 2:1, 3:1
- **Max Leverage:** 10x
- **Hold Time:** ~20 4H candles (3+ days)

#### Scalp Template (15m/5m)
- **Anchor:** 1h, 15m (intraday trend)
- **Confirm:** 15m
- **Entry:** 5m
- **Min Confidence:** 65%
- **Risk/Reward:** 1:1, 1.5:1
- **Max Leverage:** 25x
- **Hold Time:** ~12 5m candles (1 hour)

**Evaluation Logic:**
1. Check anchor timeframe for clear trend
2. Verify confirmation timeframes align
3. Calculate entry zone around 21 EMA
4. Determine stop loss from swing points
5. Score confidence based on alignment
6. Return valid signal if confidence ≥ threshold

### 6. **lib/candleFeatures.js**
**Purpose:** Analyze individual candle characteristics

**Features Extracted:**
- Body size percentage
- Upper/lower wick percentages
- Close position in range
- Candle type (rejection, engulfing, inside bar)
- Momentum strength

### 7. **lib/levels.js**
**Purpose:** Calculate support and resistance levels

**Calculations:**
- Nearest support/resistance from swing points
- Distance to levels (percentage)
- Detection of breaks (close above/below)
- "At level" detection (within tolerance)

### 8. **lib/volumeAnalysis.js**
**Purpose:** Analyze trading volume

**Metrics:**
- Current volume
- 20-period average
- Volume trend (increasing/decreasing/flat)

### 9. **lib/confluenceScoring.js**
**Purpose:** Multi-factor confluence scoring

**Scores Calculated:**
- Trend alignment score
- Stochastic RSI score
- Structure score (swings)
- Moving average score
- VWAP score

Combined into overall confluence rating.

## 🔧 How to Use These Files

### Running Locally
```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Test API endpoints
curl http://localhost:3000/api/analyze/BTCUSDT
curl http://localhost:3000/api/indicators?symbol=ETHUSDT&intervals=4h
```

### Integration Example
```javascript
// Import strategy engine
const { evaluateStrategy } = require('./services/strategy.js');

// Get multi-timeframe data
const analysis = await fetchAnalysis('BTCUSDT');

// Evaluate 4H strategy
const signal = evaluateStrategy(analysis, 'BTCUSDT');

// Check if valid trade
if (signal.valid && signal.direction !== 'NO_TRADE') {
  console.log(`${signal.direction} signal with ${signal.confidence * 100}% confidence`);
  console.log(`Entry: ${signal.entryZone.min} - ${signal.entryZone.max}`);
  console.log(`Stop Loss: ${signal.stopLoss}`);
  console.log(`TP1: ${signal.targets.tp1} (${signal.riskReward.tp1RR}:1 RR)`);
}
```

### API Response Format
```json
{
  "symbol": "BTCUSDT",
  "currentPrice": 91234.56,
  "priceChange24h": 2.34,
  "tradeSignal": {
    "valid": true,
    "direction": "long",
    "confidence": 0.82,
    "reason": "4h uptrend, 1h aligned, price near 21 EMA",
    "entryZone": { "min": 90500, "max": 91000 },
    "stopLoss": 89800,
    "targets": { "tp1": 91700, "tp2": 92400 },
    "riskReward": { "tp1RR": 1.1, "tp2RR": 2.2 }
  },
  "analysis": {
    "4h": { /* full 4H timeframe data */ },
    "1h": { /* full 1H timeframe data */ },
    "15m": { /* full 15M timeframe data */ },
    "5m": { /* full 5M timeframe data */ }
  }
}
```

## 📈 Strategy Philosophy

### Core Principles
1. **Multi-Timeframe Alignment** - Higher TF sets bias, lower TF for entry
2. **Trend Following** - Only trade with clear directional bias
3. **Mean Reversion Entry** - Enter on pullbacks to 21 EMA
4. **Risk Management** - Always use swing-based stop losses
5. **Confluence Required** - Multiple factors must align

### Entry Checklist (4H Strategy)
- [ ] 4H trend is clear (UPTREND or DOWNTREND)
- [ ] 1H confirms 4H direction
- [ ] Price within 3% of 21 EMA
- [ ] Stochastic RSI aligned
- [ ] 15m/5m shows pullback completion
- [ ] Swing low/high clearly defined for SL
- [ ] Risk/reward ≥ 1:1 to TP1

### Exit Strategy
- **Stop Loss:** Just beyond swing high/low (invalidation point)
- **TP1:** 1:1 risk/reward (move SL to breakeven)
- **TP2:** 2:1 risk/reward (trail remaining position)

## 🚀 Deployment

These files are deployed as:
- **Vercel Serverless Functions** (`api/` folder)
- **Frontend JavaScript** (`frontend_template_logic.js` embedded in HTML)
- **Node.js Modules** (`services/` and `lib/` imported by API functions)

Live endpoints:
- https://snapshottradingview-[hash].vercel.app/api/analyze/BTCUSDT
- https://snapshottradingview-[hash].vercel.app/api/indicators?symbol=ETHUSDT

---

**Last Updated:** 2025-01-27  
**Version:** 2.0.0  
**Project:** EditTrades - 4H Trading Strategy Scanner

