# System Workflow & Element Impact Guide

**Last Updated:** 2025-01-XX  
**Purpose:** Complete documentation of system workflow and how tweaking elements affects strategy evaluation and output.

---

## Table of Contents

1. [Complete System Workflow](#complete-system-workflow)
2. [Data Flow Architecture](#data-flow-architecture)
3. [How Tweaking Elements Affects Strategies](#how-tweaking-elements-affects-strategies)
4. [Element Impact Matrix](#element-impact-matrix)
5. [Strategy Evaluation Flow](#strategy-evaluation-flow)
6. [Confidence Calculation Flow](#confidence-calculation-flow)
7. [Frontend Rendering Flow](#frontend-rendering-flow)

---

## Complete System Workflow

### High-Level Flow

```
User Request (Frontend/API)
    ↓
1. Market Data Fetching (services/marketData.js)
    ├─→ Kraken API (OHLCV, Ticker, Order Book, Recent Trades)
    ├─→ dFlow API (Prediction Markets)
    └─→ Data Aggregation (1w, 1M, 3d from daily candles)
    ↓
2. Indicator Calculation (services/indicators.js)
    ├─→ EMA21, EMA200
    ├─→ Stochastic RSI
    ├─→ Trend Detection
    ├─→ Pullback State Analysis
    └─→ Swing Point Detection
    ↓
3. Strategy Evaluation (services/strategy.js)
    ├─→ HTF Bias Calculation
    ├─→ Strategy Gatekeepers
    ├─→ Entry Logic Evaluation
    ├─→ Confidence Scoring (Hierarchical)
    ├─→ SL/TP Calculation
    └─→ Signal Generation
    ↓
4. API Response Assembly (api/analyze-full.js)
    ├─→ Rich Symbol Object
    ├─→ All Strategies Results
    ├─→ Best Signal Selection
    └─→ Market Data Integration
    ↓
5. Frontend Rendering (public/index.html)
    ├─→ Trade Call Display
    ├─→ AI Analytics Section
    ├─→ Market Data Section
    ├─→ Prediction Markets Section
    ├─→ Timeframe Grid
    └─→ JSON Export
```

### Detailed Step-by-Step Workflow

#### Step 1: Market Data Fetching

**File:** `services/marketData.js`

**Process:**
1. **OHLCV Data Fetching:**
   - `getMultiTimeframeData(symbol, intervals, limit)` called
   - For each interval: `getCandles(symbol, interval, limit)`
   - Direct intervals (1m, 3m, 5m, 15m, 1h, 4h, 1d): Fetched from Kraken
   - Aggregated intervals (1w, 1M, 3d): Built from daily candles
   - Returns: `{ '1m': [...candles], '3m': [...candles], ... }`

2. **Ticker Data Fetching:**
   - `getTickerPrice(symbol)` called
   - Extracts: `price`, `bid`, `ask`, `spread`, `bidAskImbalance`, `volume24h`, `tradeCount24h`
   - Returns: Ticker object with all market metrics

3. **Order Book Data:**
   - `getOrderBookDepth(symbol, limit)` called
   - Calculates: `bidLiquidity`, `askLiquidity`, `imbalance`
   - Returns: Order book metrics

4. **Recent Trades Flow:**
   - `getRecentTrades(symbol, limit)` called
   - Analyzes: `overallFlow`, `buyPressure`, `sellPressure`, `volumeImbalance`
   - Returns: Trade flow metrics

5. **dFlow Prediction Markets:**
   - `getDflowPredictionMarkets(symbol)` called
   - Fetches: Events, markets, live data, outcome mints
   - Returns: Prediction market data structure

**Output:** Multi-timeframe candle data + market metrics

---

#### Step 2: Indicator Calculation

**File:** `services/indicators.js`

**Process:**
1. **For Each Timeframe:**
   - `calculateAllIndicators(candles)` called
   - Extracts: `open`, `high`, `low`, `close`, `volume`, `vwap`, `tradeCount`

2. **EMA Calculation:**
   - `calculateEMA21(closes)` → 21-period EMA
   - `calculateEMA200(closes)` → 200-period EMA
   - Returns: Current value + history array

3. **Stochastic RSI Calculation:**
   - `calculateStochRSI(closes)` → %K, %D, condition
   - Condition: `OVERBOUGHT` | `OVERSOLD` | `BULLISH` | `BEARISH` | `NEUTRAL`
   - Returns: `{ k, d, condition, history }`

4. **Trend Detection:**
   - `detectTrend(price, ema21, ema200)` → `UPTREND` | `DOWNTREND` | `FLAT`
   - Logic:
     - `UPTREND`: `price > ema21 > ema200`
     - `DOWNTREND`: `price < ema21 < ema200`
     - `FLAT`: Otherwise

5. **Pullback State Analysis:**
   - `analyzePullbackState(price, ema21, distance)` → `ENTRY_ZONE` | `RETRACING` | `OVEREXTENDED` | `UNKNOWN`
   - Logic:
     - `ENTRY_ZONE`: Within ±1% of EMA21
     - `RETRACING`: 1-5% from EMA21
     - `OVEREXTENDED`: >5% from EMA21

6. **Swing Point Detection:**
   - `detectSwingPoints(candles, lookback)` → `{ swingHigh, swingLow }`
   - Uses: Local maxima/minima detection

**Output:** Complete indicator object per timeframe:
```javascript
{
  price: { current, high, low, vwap },
  ema: { ema21, ema200, ema21History, ema200History },
  stochRSI: { k, d, condition, history },
  analysis: { trend, pullbackState, distanceFrom21EMA },
  structure: { swingHigh, swingLow },
  metadata: { candleCount, tradeCount, lastUpdate }
}
```

---

#### Step 3: Strategy Evaluation

**File:** `services/strategy.js`

**Process:**
1. **HTF Bias Calculation:**
   - `computeHTFBias(multiTimeframeData)` called
   - Analyzes: 1M, 1w, 3d, 1d timeframes
   - Returns: `{ direction: 'long'|'short'|'neutral', confidence: 0-100, source: string }`

2. **Strategy Evaluation:**
   - `evaluateAllStrategies(symbol, analysis, mode)` called
   - Evaluates all strategies:
     - `SWING` → `evaluateSwingSetup()`
     - `TREND_4H` → `evaluateStrategy(..., '4h')`
     - `TREND_RIDER` → `evaluateTrendRider()`
     - `SCALP_1H` → `evaluateStrategy(..., 'Scalp')`
     - `MICRO_SCALP` → `evaluateMicroScalp()`

3. **For Each Strategy:**
   - **Gatekeepers Check:**
     - Mode-specific rules (STANDARD vs AGGRESSIVE)
     - Trend requirements (4H must not be FLAT in STANDARD)
     - HTF bias requirements
   - **Entry Logic:**
     - Trend alignment checks
     - EMA position checks
     - Stoch RSI alignment
     - Pullback state validation
   - **Confidence Calculation:**
     - `calculateConfidenceWithHierarchy()` called
     - Hierarchical weighting (Macro 40%, Primary 35%, Execution 25%)
     - Penalties applied for contradictions
     - Hard caps applied
   - **SL/TP Calculation:**
     - `calculateSLTP()` called
     - Uses swing points for structure
     - Calculates risk-reward ratios
   - **Signal Generation:**
     - Builds complete signal object
     - Validates all fields
     - Returns: `{ valid, direction, confidence, entryZone, stopLoss, targets, ... }`

4. **Best Signal Selection:**
   - Priority arrays (STANDARD vs AGGRESSIVE)
   - Selects highest priority valid strategy
   - Returns: Strategy name or `null`

**Output:** Complete strategy results object:
```javascript
{
  strategies: {
    SWING: { valid, direction, confidence, ... },
    TREND_4H: { valid, direction, confidence, ... },
    TREND_RIDER: { valid, direction, confidence, ... },
    SCALP_1H: { valid, direction, confidence, ... },
    MICRO_SCALP: { valid, direction, confidence, ... }
  },
  bestSignal: 'TREND_4H' | null
}
```

---

#### Step 4: API Response Assembly

**File:** `api/analyze-full.js`

**Process:**
1. **Fetch All Data:**
   - Multi-timeframe candles
   - Ticker data
   - Order book
   - Recent trades
   - dFlow prediction markets

2. **Calculate Indicators:**
   - For each timeframe: `calculateAllIndicators()`

3. **Evaluate Strategies:**
   - `evaluateAllStrategies()` → All strategy results

4. **Build Rich Symbol Object:**
   - Symbol metadata
   - Current price
   - Market data (spread, bid/ask, volume quality, etc.)
   - HTF bias
   - Timeframes (all indicator data)
   - Strategies (all evaluated strategies)
   - Best signal
   - dFlow data
   - JSON version

5. **Return JSON Response:**
   - Complete rich symbol object
   - All data for frontend consumption

**Output:** Rich symbol JSON object

---

#### Step 5: Frontend Rendering

**File:** `public/index.html`

**Process:**
1. **Data Reception:**
   - Receives rich symbol object from API
   - Stores in `scanResults` object

2. **Trade Call Display:**
   - Extracts `bestSignal` from strategies
   - Displays: Direction, confidence, entry zone, SL, targets
   - Shows "NO TRADE" if no valid signal

3. **AI Analytics Section:**
   - Displays AI reasoning (if available)
   - Shows strategy-specific analysis

4. **Market Data Section:**
   - Spread, bid/ask, imbalance
   - Volume quality
   - Order book depth
   - Recent trades flow
   - Prediction markets

5. **Timeframe Grid:**
   - For each timeframe: Trend, EMA values, Stoch RSI, pullback state
   - Color-coded indicators

6. **JSON Export:**
   - `copyCoinView()` → Single coin JSON
   - `copyAllCoinsView()` → All coins JSON
   - Includes all data from rich symbol object

**Output:** Rendered HTML + JSON export capability

---

## Data Flow Architecture

### Component Interaction Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    EXTERNAL DATA SOURCES                      │
├─────────────────────────────────────────────────────────────┤
│  Kraken API          │  dFlow API                            │
│  - OHLCV             │  - Events                             │
│  - Ticker            │  - Markets                            │
│  - Order Book        │  - Live Data                          │
│  - Recent Trades     │  - Outcome Mints                      │
└──────────┬───────────┴───────────┬──────────────────────────┘
           │                       │
           ▼                       ▼
┌─────────────────────────────────────────────────────────────┐
│              services/marketData.js                          │
│  - getMultiTimeframeData()                                  │
│  - getTickerPrice()                                         │
│  - getOrderBookDepth()                                      │
│  - getRecentTrades()                                        │
│  - getDflowPredictionMarkets()                              │
└──────────┬──────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│              services/indicators.js                          │
│  - calculateAllIndicators()                                 │
│  - detectSwingPoints()                                      │
│  Returns: { price, ema, stochRSI, analysis, structure }    │
└──────────┬──────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│              services/strategy.js                            │
│  - computeHTFBias()                                         │
│  - evaluateAllStrategies()                                  │
│    ├─→ evaluateSwingSetup()                                 │
│    ├─→ evaluateStrategy(..., '4h')                         │
│    ├─→ evaluateTrendRider()                                 │
│    ├─→ evaluateStrategy(..., 'Scalp')                       │
│    └─→ evaluateMicroScalp()                                 │
│  - calculateConfidenceWithHierarchy()                       │
│  - calculateSLTP()                                          │
└──────────┬──────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│              api/analyze-full.js                             │
│  - Assembles rich symbol object                             │
│  - Combines all data sources                                │
│  - Returns JSON response                                    │
└──────────┬──────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────┐
│              public/index.html                              │
│  - Renders trade signals                                    │
│  - Displays market data                                     │
│  - Shows timeframe grid                                     │
│  - Exports JSON                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## How Tweaking Elements Affects Strategies

### 1. Indicator Changes

#### EMA21/EMA200 Modifications

**What Changes:**
- Period length (e.g., EMA21 → EMA50)
- Calculation method
- Smoothing factor

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **HIGH** | Entry zone calculation uses EMA21. Changing period shifts entry zones. Trend detection uses EMA alignment. |
| **TREND_4H** | **HIGH** | Entry zone anchored to EMA21. Trend detection relies on EMA21/EMA200 alignment. Pullback state uses EMA21 distance. |
| **TREND_RIDER** | **HIGH** | Uses EMA21 for entry zones and trend confirmation. EMA200 for trend validation. |
| **SCALP_1H** | **MEDIUM** | Entry zone uses EMA21. Trend detection uses EMA alignment. |
| **MICRO_SCALP** | **MEDIUM** | Entry zone uses EMA21. Trend detection uses EMA alignment. |

**Confidence Impact:**
- **Macro Layer (40%):** Trend detection changes → affects macro alignment score
- **Primary Layer (35%):** EMA position changes → affects primary trend score
- **Execution Layer (25%):** Pullback state changes → affects execution score

**Example:**
```javascript
// Changing EMA21 period from 21 to 50
// Before: EMA21 = $50,000 (faster, more reactive)
// After: EMA50 = $50,200 (slower, less reactive)

// Impact:
// - Entry zones shift (e.g., $50,000 ± 0.4% → $50,200 ± 0.4%)
// - Trend detection changes (price > EMA21 may become price < EMA50)
// - Pullback state changes (distance from EMA changes)
// - Confidence scores adjust based on new alignment
```

---

#### Stochastic RSI Modifications

**What Changes:**
- Periods (RSI period, Stoch period, %K smoothing, %D smoothing)
- Overbought/oversold thresholds
- Condition logic

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **HIGH** | Uses Stoch for entry confirmation. BULLISH/OVERSOLD conditions required. |
| **TREND_4H** | **MEDIUM** | Uses Stoch for LTF confirmation. Alignment affects confidence. |
| **TREND_RIDER** | **MEDIUM** | Uses Stoch for 15m/5m confirmation. Required for entry. |
| **SCALP_1H** | **MEDIUM** | Uses Stoch for 15m alignment. Affects confidence. |
| **MICRO_SCALP** | **LOW** | Uses Stoch for confirmation but not critical. |

**Confidence Impact:**
- **Execution Layer (25%):** Stoch alignment directly affects execution score
- **Penalties:** Overbought in uptrend or oversold in downtrend → penalties applied

**Example:**
```javascript
// Changing Stoch RSI periods from (14,14,3,3) to (21,21,5,5)
// Before: More reactive, faster signals
// After: Less reactive, slower signals

// Impact:
// - Entry conditions may trigger later (less sensitive)
// - Condition changes (BULLISH/OVERSOLD thresholds shift)
// - Confidence scores adjust (execution layer affected)
```

---

#### Trend Detection Logic Changes

**What Changes:**
- Trend detection algorithm
- Thresholds for UPTREND/DOWNTREND/FLAT
- Timeframe weighting

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **CRITICAL** | Gatekeeper: 4H/3D/1D trends must not be FLAT. Changes block/allow trades. |
| **TREND_4H** | **CRITICAL** | Gatekeeper: 4H trend must not be FLAT (STANDARD mode). Changes block/allow trades. |
| **TREND_RIDER** | **CRITICAL** | Requires 4H/1H trend alignment. Changes block/allow trades. |
| **SCALP_1H** | **HIGH** | Uses 1H trend. Changes affect entry logic. |
| **MICRO_SCALP** | **MEDIUM** | Uses 1H trend. Changes affect entry logic. |

**Confidence Impact:**
- **Macro Layer (40%):** Trend alignment is primary factor
- **Primary Layer (35%):** Trend alignment is primary factor
- **Hard Caps:** Contradictory trends → caps applied

**Example:**
```javascript
// Changing trend detection to require 3 consecutive candles
// Before: Trend = UPTREND if price > EMA21 > EMA200 (single candle)
// After: Trend = UPTREND if price > EMA21 > EMA200 for 3 candles

// Impact:
// - Fewer UPTREND/DOWNTREND signals (more FLAT)
// - More strategies blocked (gatekeepers fail)
// - Confidence scores lower (less alignment)
```

---

#### Pullback State Logic Changes

**What Changes:**
- Distance thresholds (ENTRY_ZONE, RETRACING, OVEREXTENDED)
- Calculation method
- Timeframe-specific thresholds

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **HIGH** | Requires specific pullback states (OVEREXTENDED on 3D, RETRACING on 1D). |
| **TREND_4H** | **MEDIUM** | Uses pullback state for entry zone validation. |
| **TREND_RIDER** | **MEDIUM** | Uses pullback state for entry validation. |
| **SCALP_1H** | **MEDIUM** | Uses pullback state for entry validation. |
| **MICRO_SCALP** | **LOW** | Uses pullback state but not critical. |

**Confidence Impact:**
- **Execution Layer (25%):** Pullback state affects execution score
- **Bonuses:** Tight pullbacks → bonuses applied

**Example:**
```javascript
// Changing ENTRY_ZONE threshold from ±1% to ±0.5%
// Before: ENTRY_ZONE if within ±1% of EMA21
// After: ENTRY_ZONE if within ±0.5% of EMA21

// Impact:
// - Fewer ENTRY_ZONE signals (stricter)
// - More RETRACING signals
// - Entry conditions may fail (stricter requirements)
// - Confidence scores adjust (execution layer affected)
```

---

### 2. Market Data Changes

#### Spread/Bid-Ask Imbalance Changes

**What Changes:**
- Spread calculation method
- Bid-ask imbalance thresholds
- Volume quality calculation

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **LOW** | Currently not used in strategy logic (display only). |
| **TREND_4H** | **LOW** | Currently not used in strategy logic (display only). |
| **TREND_RIDER** | **LOW** | Currently not used in strategy logic (display only). |
| **SCALP_1H** | **LOW** | Currently not used in strategy logic (display only). |
| **MICRO_SCALP** | **LOW** | Currently not used in strategy logic (display only). |

**Future Integration:**
- High spread → Lower confidence (execution difficulty)
- High bid-ask imbalance → Directional bias signal
- Volume quality → Confidence multiplier

**Example:**
```javascript
// Adding spread penalty to confidence calculation
// Before: Confidence = 75% (no spread consideration)
// After: Confidence = 75% - (spreadPercent * 10) = 70% (if spread = 0.5%)

// Impact:
// - Lower confidence for high-spread pairs
// - More NO_TRADE signals for illiquid pairs
// - Better risk-adjusted signals
```

---

#### Order Book Depth Changes

**What Changes:**
- Liquidity calculation method
- Imbalance thresholds
- Depth levels analyzed

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **All Strategies** | **LOW** | Currently not used in strategy logic (display only). |

**Future Integration:**
- Low liquidity → Lower confidence (slippage risk)
- High imbalance → Directional bias signal
- Depth analysis → Entry zone refinement

---

#### Recent Trades Flow Changes

**What Changes:**
- Flow calculation method
- Pressure thresholds
- Volume imbalance calculation

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **All Strategies** | **LOW** | Currently not used in strategy logic (display only). |

**Future Integration:**
- Buy pressure → Long bias signal
- Sell pressure → Short bias signal
- Volume imbalance → Confidence multiplier

---

### 3. Strategy Parameter Changes

#### Confidence Calculation Changes

**What Changes:**
- Hierarchical weights (Macro 40%, Primary 35%, Execution 25%)
- Penalty multipliers
- Hard cap thresholds
- Bonus conditions

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **All Strategies** | **CRITICAL** | Directly affects confidence scores. Changes which trades are valid. |

**Example:**
```javascript
// Changing Macro Layer weight from 40% to 50%
// Before: Macro 40%, Primary 35%, Execution 25%
// After: Macro 50%, Primary 30%, Execution 20%

// Impact:
// - Higher timeframes have more influence
// - Lower timeframes have less influence
// - Confidence scores shift (higher for HTF-aligned trades)
// - More/less valid trades depending on HTF alignment
```

---

#### Entry Zone Calculation Changes

**What Changes:**
- Buffer percentages
- Calculation method
- Timeframe anchoring

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **HIGH** | Entry zone directly affects trade execution. |
| **TREND_4H** | **HIGH** | Entry zone directly affects trade execution. |
| **TREND_RIDER** | **HIGH** | Entry zone directly affects trade execution. |
| **SCALP_1H** | **HIGH** | Entry zone directly affects trade execution. |
| **MICRO_SCALP** | **HIGH** | Entry zone directly affects trade execution. |

**Example:**
```javascript
// Changing entry zone buffer from 0.4% to 0.8%
// Before: Entry zone = EMA21 ± 0.4%
// After: Entry zone = EMA21 ± 0.8%

// Impact:
// - Wider entry zones (easier to fill)
// - More trades may become valid (wider acceptance)
// - Risk-reward ratios adjust (wider zones = larger risk)
```

---

#### Stop Loss Calculation Changes

**What Changes:**
- Buffer percentages
- Structure usage (swing points)
- Invalidation logic

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **HIGH** | Stop loss directly affects risk-reward. |
| **TREND_4H** | **HIGH** | Stop loss directly affects risk-reward. |
| **TREND_RIDER** | **HIGH** | Stop loss directly affects risk-reward. |
| **SCALP_1H** | **HIGH** | Stop loss directly affects risk-reward. |
| **MICRO_SCALP** | **HIGH** | Stop loss directly affects risk-reward. |

**Example:**
```javascript
// Changing stop loss buffer from 0.3% to 0.5%
// Before: Stop loss = swingLow * (1 - 0.003)
// After: Stop loss = swingLow * (1 - 0.005)

// Impact:
// - Wider stop losses (more room for price movement)
// - Lower risk-reward ratios (larger risk)
// - Fewer stop-outs (more room)
// - Confidence may adjust (wider stops = less precise)
```

---

#### Target Calculation Changes

**What Changes:**
- Risk-reward ratios
- Number of targets
- Calculation method

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **MEDIUM** | Targets affect profit potential but not entry logic. |
| **TREND_4H** | **MEDIUM** | Targets affect profit potential but not entry logic. |
| **TREND_RIDER** | **MEDIUM** | Targets affect profit potential but not entry logic. |
| **SCALP_1H** | **MEDIUM** | Targets affect profit potential but not entry logic. |
| **MICRO_SCALP** | **MEDIUM** | Targets affect profit potential but not entry logic. |

**Example:**
```javascript
// Changing R:R ratios from [1.0, 2.0] to [1.5, 3.0]
// Before: TP1 = 1.0R, TP2 = 2.0R
// After: TP1 = 1.5R, TP2 = 3.0R

// Impact:
// - Higher profit targets (better R:R)
// - Fewer targets hit (harder to reach)
// - Better risk-adjusted returns (if targets hit)
// - No impact on entry logic or confidence
```

---

### 4. Mode Changes (STANDARD vs AGGRESSIVE)

**What Changes:**
- Gatekeeper strictness
- Minimum confidence thresholds
- Trend requirements
- HTF bias requirements

**Impact on Strategies:**

| Strategy | Impact | How It Changes |
|----------|--------|----------------|
| **SWING** | **HIGH** | STANDARD: Strict 4H/3D/1D trend requirements. AGGRESSIVE: Looser requirements. |
| **TREND_4H** | **CRITICAL** | STANDARD: 4H must not be FLAT (hard block). AGGRESSIVE: Can use HTF bias when 4H is FLAT. |
| **TREND_RIDER** | **HIGH** | STANDARD: Strict 4H trend requirements. AGGRESSIVE: Can use HTF bias when 4H is FLAT. |
| **SCALP_1H** | **MEDIUM** | STANDARD: Blocked if HTF bias contradicts. AGGRESSIVE: Less blocking. |
| **MICRO_SCALP** | **MEDIUM** | STANDARD: Higher confidence threshold. AGGRESSIVE: Lower threshold. |

**Example:**
```javascript
// Switching from STANDARD to AGGRESSIVE mode
// Before: 4H FLAT → All strategies blocked
// After: 4H FLAT → Can use HTF bias if confidence >= 70%

// Impact:
// - More valid trades (less blocking)
// - Lower confidence thresholds (easier to trigger)
// - More risk (looser requirements)
// - Better market coverage (more opportunities)
```

---

## Element Impact Matrix

### Quick Reference: How Changes Affect Strategies

| Element | SWING | TREND_4H | TREND_RIDER | SCALP_1H | MICRO_SCALP | Confidence | Notes |
|---------|-------|----------|-------------|----------|-------------|------------|-------|
| **EMA21 Period** | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🟡 MED | 🟡 MED | 🟡 MED | Entry zones, trend detection |
| **EMA200 Period** | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🟡 MED | 🟡 MED | 🟡 MED | Trend detection |
| **Stoch RSI Periods** | 🔴 HIGH | 🟡 MED | 🟡 MED | 🟡 MED | 🟢 LOW | 🟡 MED | Entry confirmation |
| **Trend Detection** | 🔴 CRITICAL | 🔴 CRITICAL | 🔴 CRITICAL | 🔴 HIGH | 🟡 MED | 🔴 HIGH | Gatekeepers |
| **Pullback Thresholds** | 🔴 HIGH | 🟡 MED | 🟡 MED | 🟡 MED | 🟢 LOW | 🟡 MED | Entry validation |
| **Confidence Weights** | 🔴 CRITICAL | 🔴 CRITICAL | 🔴 CRITICAL | 🔴 CRITICAL | 🔴 CRITICAL | 🔴 CRITICAL | All strategies |
| **Entry Zone Buffer** | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🟢 LOW | Trade execution |
| **Stop Loss Buffer** | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🔴 HIGH | 🟢 LOW | Risk-reward |
| **R:R Ratios** | 🟡 MED | 🟡 MED | 🟡 MED | 🟡 MED | 🟡 MED | 🟢 LOW | Profit targets |
| **Mode (STANDARD/AGGRESSIVE)** | 🔴 HIGH | 🔴 CRITICAL | 🔴 HIGH | 🟡 MED | 🟡 MED | 🟡 MED | Gatekeepers |
| **Spread/Bid-Ask** | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | Display only (future) |
| **Order Book Depth** | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | Display only (future) |
| **Trade Flow** | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | 🟢 LOW | Display only (future) |

**Legend:**
- 🔴 **CRITICAL/HIGH:** Changes directly affect strategy logic, gatekeepers, or entry conditions
- 🟡 **MEDIUM:** Changes affect confidence, validation, or secondary logic
- 🟢 **LOW:** Changes have minimal or no impact (display only, future integration)

---

## Strategy Evaluation Flow

### Detailed Evaluation Process

```
1. Input: Multi-timeframe analysis data
   ↓
2. Compute HTF Bias
   ├─→ Analyze 1M, 1w, 3d, 1d timeframes
   ├─→ Determine direction (long/short/neutral)
   └─→ Calculate confidence (0-100%)
   ↓
3. For Each Strategy (SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP):
   ├─→ Check Gatekeepers
   │   ├─→ Mode-specific rules
   │   ├─→ Trend requirements
   │   ├─→ HTF bias requirements
   │   └─→ Minimum confidence thresholds
   │
   ├─→ If Gatekeepers Pass:
   │   ├─→ Evaluate Entry Logic
   │   │   ├─→ Trend alignment checks
   │   │   ├─→ EMA position checks
   │   │   ├─→ Stoch RSI alignment
   │   │   └─→ Pullback state validation
   │   │
   │   ├─→ Calculate Entry Zone
   │   │   ├─→ Anchor to EMA21 (or strategy-specific)
   │   │   └─→ Apply buffer percentages
   │   │
   │   ├─→ Calculate Confidence
   │   │   ├─→ Hierarchical weighting
   │   │   ├─→ Apply penalties
   │   │   ├─→ Apply hard caps
   │   │   └─→ Apply bonuses
   │   │
   │   ├─→ Calculate SL/TP
   │   │   ├─→ Use swing points for structure
   │   │   ├─→ Apply buffers
   │   │   └─→ Calculate R:R ratios
   │   │
   │   └─→ Generate Signal
   │       ├─→ Build signal object
   │       ├─→ Validate all fields
   │       └─→ Return { valid: true, ... }
   │
   └─→ If Gatekeepers Fail:
       └─→ Return { valid: false, reason: '...' }
   ↓
4. Select Best Signal
   ├─→ Use priority arrays (STANDARD vs AGGRESSIVE)
   ├─→ Find highest priority valid strategy
   └─→ Return strategy name or null
   ↓
5. Output: Complete strategy results
   ├─→ All strategies (even NO_TRADE)
   └─→ Best signal
```

---

## Confidence Calculation Flow

### Hierarchical Confidence System

```
Input: Multi-timeframe data, direction, mode
   ↓
1. Macro Trend Layer (40% weight)
   ├─→ Analyze: 1M, 1w, 3d, 1d
   ├─→ Check alignment with direction
   ├─→ Apply multipliers for contradictions:
   │   ├─→ Mild contradiction → ×0.75
   │   ├─→ Moderate contradiction → ×0.6
   │   └─→ Severe contradiction → ×0.4
   └─→ Score: 0-40 points
   ↓
2. Primary Trend Layer (35% weight)
   ├─→ Analyze: 4H, 1H
   ├─→ Check alignment with direction
   ├─→ Apply multipliers for contradictions:
   │   ├─→ 4H flat but 1H aligned → ×0.85
   │   └─→ 4H opposite → ×0.5
   └─→ Score: 0-35 points
   ↓
3. Execution Layer (25% weight)
   ├─→ Analyze: 15m, 5m, 3m, 1m
   ├─→ Check Stoch RSI alignment
   ├─→ Check exhaustion states:
   │   ├─→ Overbought in long trend → ×0.9
   │   ├─→ Oversold in short trend → ×0.9
   │   └─→ Two+ LTFs exhausted → ×0.7
   └─→ Score: 0-25 points
   ↓
4. Apply Hard Caps
   ├─→ ANY macro contradiction → Max 75%
   ├─→ 4H contradiction → Max 65%
   ├─→ 1D + 4H contradiction → Max 55%
   └─→ 1D opposite + exhaustion → Max 45%
   ↓
5. Apply Bonuses (if applicable)
   ├─→ Strong alignment → +5%
   ├─→ Tight pullback → +3%
   └─→ Cap at 90% (max before hard caps)
   ↓
6. Final Confidence
   ├─→ Sum all layers
   ├─→ Apply caps
   ├─→ Apply bonuses
   └─→ Return: 0-100%
```

---

## Frontend Rendering Flow

### Display Generation Process

```
Input: Rich symbol object from API
   ↓
1. Extract Best Signal
   ├─→ Get strategy name from bestSignal
   ├─→ Get signal object from strategies[bestSignal]
   └─→ If no bestSignal → Show "NO TRADE"
   ↓
2. Render Trade Call Output
   ├─→ Direction (LONG/SHORT/NO TRADE)
   ├─→ Confidence (0-100%)
   ├─→ Entry Zone (min-max)
   ├─→ Stop Loss
   ├─→ Targets (TP1, TP2, ...)
   └─→ Reason
   ↓
3. Render AI Analytics Section
   ├─→ AI reasoning (if available)
   ├─→ Strategy-specific analysis
   └─→ Confidence explanation
   ↓
4. Render Market Data Section
   ├─→ Spread, Bid/Ask, Imbalance
   ├─→ Volume Quality
   ├─→ Order Book Depth
   ├─→ Recent Trades Flow
   └─→ Prediction Markets
   ↓
5. Render Timeframe Grid
   ├─→ For each timeframe (1m, 3m, 5m, 15m, 1h, 4h, 1d, 3d, 1w, 1M):
   │   ├─→ Trend (color-coded)
   │   ├─→ EMA21, EMA200
   │   ├─→ Stoch RSI (k, d, condition)
   │   ├─→ Pullback State
   │   └─→ Current Price
   └─→ Display in grid layout
   ↓
6. Enable JSON Export
   ├─→ copyCoinView() → Single coin JSON
   ├─→ copyAllCoinsView() → All coins JSON
   └─→ Includes all data from rich symbol object
```

---

## Best Practices for Tweaking Elements

### 1. Indicator Changes

**DO:**
- Test changes on historical data first
- Update all affected strategies simultaneously
- Maintain backward compatibility (handle null/undefined)
- Update documentation

**DON'T:**
- Change indicators without understanding strategy dependencies
- Break existing indicator structure
- Remove indicators that strategies depend on
- Change calculations without testing

### 2. Strategy Parameter Changes

**DO:**
- Test in STANDARD mode first, then AGGRESSIVE
- Verify confidence scores make sense
- Check that entry zones are reasonable
- Validate SL/TP calculations

**DON'T:**
- Change parameters without understanding impact
- Break gatekeeper logic
- Remove required fields from signals
- Change mode behavior without testing both modes

### 3. Market Data Integration

**DO:**
- Add market data to display first
- Test API reliability
- Add to JSON export
- Document data structure

**DON'T:**
- Integrate into strategies without thorough testing
- Break existing market data display
- Remove fallback values
- Assume data is always available

---

## Related Documentation

- **`INDICATOR_ARCHITECTURE.md`** - Indicator system architecture
- **`STRATEGY_SYSTEM_AUDIT.md`** - Complete strategy audit
- **`STRATEGY_IMPLEMENTATION_GUIDE.md`** - Strategy implementation details
- **`ADDING_INDICATORS.md`** - How to add new indicators
- **`ADDING_STRATEGIES.md`** - How to add new strategies
- **`MARKETDATA_MODULE.md`** - Market data module reference

---

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0

