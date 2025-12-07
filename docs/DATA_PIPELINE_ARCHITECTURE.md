# Data Pipeline Architecture

**Last Updated:** 2025-01-XX  
**Status:** Production Ready - Complete TradingView-level parity achieved  
**Milestone Tag:** `v1.0-data-parity`

---

## Overview

The data pipeline transforms raw market data into comprehensive, structured JSON suitable for AI agent consumption and professional-grade signal generation. This document describes the complete flow from data ingestion to JSON export.

---

## Pipeline Flow

```
┌─────────────────┐
│  Market Data    │ (Binance/CoinGecko APIs)
│  (OHLCV)        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Data Fetching  │ (dataService.fetchKlines)
│  Multi-TF       │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Step 1: Basic Indicators           │
│  - EMA21, EMA200                    │
│  - Stochastic RSI                   │
│  - RSI                              │
│  - Trend Classification             │
│  - Swing Points                     │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Step 2: Advanced Chart Analysis     │
│  - Market Structure (BOS/CHOCH)     │
│  - Volume Profile (HVN/LVN)          │
│  - Liquidity Zones                  │
│  - Fair Value Gaps                  │
│  - Divergences                      │
│  - Volatility (ATR)                 │
│  - Volume Analysis                  │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Step 3: Data Validation            │
│  - Structure validation             │
│  - Fallback enforcement             │
│  - Consistency checks               │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Step 4: Strategy Evaluation        │
│  - Multi-strategy analysis          │
│  - Confidence scoring               │
│  - HTF Bias calculation             │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Step 5: Timeframe Summary          │
│  - buildTimeframeSummary()          │
│  - Merges all modules               │
│  - Structured fallbacks             │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Step 6: JSON Export                │
│  - Frontend export functions         │
│  - Structured fallbacks             │
│  - Final consistency check          │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Final JSON     │ (Complete, structured)
│  (AI-Ready)     │
└─────────────────┘
```

---

## Core Components

### 1. Data Fetching Layer

**Location:** `services/data.js`, `services/coingecko.js`

**Responsibilities:**
- Fetch OHLCV candles from Binance/CoinGecko
- Handle rate limiting and errors
- Return standardized candle format

**Key Functions:**
```javascript
fetchKlines(symbol, interval, limit)
```

**Error Handling:**
- Falls back to CoinGecko if Binance fails
- Returns empty array on complete failure
- Logs errors for debugging

---

### 2. Indicator Calculation Layer

**Location:** `services/indicators.js`

**Responsibilities:**
- Calculate basic indicators (EMA, RSI, StochRSI)
- Detect swing points
- Classify trend direction
- Calculate trend strength (ADX)

**Key Functions:**
```javascript
calculateAllIndicators(candles)
detectSwingPoints(candles, lookback)
```

**Output Structure:**
```javascript
{
  price: { current, high, low },
  ema: { ema21, ema200, ema21History, ema200History },
  stochRSI: { k, d, condition, history },
  rsi: { value, history, overbought, oversold },
  analysis: { trend, pullbackState, distanceFrom21EMA },
  trendStrength: { adx, trend },
  candlestickPatterns: { ... },
  wickAnalysis: { ... }
}
```

---

### 3. Advanced Chart Analysis Layer

**Location:** `lib/advancedChartAnalysis.js`

**Responsibilities:**
- Calculate market structure (BOS/CHOCH)
- Generate volume profile
- Detect liquidity zones
- Find fair value gaps
- Identify divergences

**Key Functions:**
```javascript
calculateAllAdvancedChartAnalysis(candles, indicators, swingPoints, trend)
```

**Module Functions:**
- `calculateMarketStructure()` - Returns structured object (never null)
- `calculateVolumeProfile()` - Returns structured object (never null)
- `calculateLiquidityZones()` - Returns array (never null)
- `calculateFairValueGaps()` - Returns array (never null)
- `calculateDivergences()` - Returns array (never null)

**Critical Rule:** All functions must return structured objects/arrays, never `null`.

---

### 4. Volatility Analysis Layer

**Location:** `lib/advancedIndicators.js`

**Responsibilities:**
- Calculate ATR (Average True Range)
- Classify volatility state (low/normal/high/extreme)
- Calculate ATR as percentage of price

**Key Function:**
```javascript
calculateATR(candles, period = 14)
```

**Output:**
```javascript
{
  atr: number,
  atrPct: number,
  volatilityState: 'low' | 'normal' | 'high' | 'extreme'
}
```

**State Classification:**
- `low`: ATR% < 0.5
- `normal`: 0.5 <= ATR% <= 2.0
- `high`: 2.0 < ATR% <= 5.0
- `extreme`: ATR% > 5.0

---

### 5. Volume Analysis Layer

**Location:** `lib/volumeAnalysis.js`

**Responsibilities:**
- Calculate current volume
- Calculate 20-period average volume
- Determine volume trend (up/down/flat)

**Key Function:**
```javascript
calculateVolumeAnalysis(candles, period = 20)
```

**Output:**
```javascript
{
  current: number,
  avg20: number,
  trend: 'up' | 'down' | 'flat'
}
```

**Fallback:** Always returns structured object, never `null`.

---

### 6. Data Validation Layer

**Location:** `lib/dataValidation.js`

**Responsibilities:**
- Ensure all modules exist (never null)
- Fix data inconsistencies
- Enforce structured fallbacks
- Validate enums and ranges

**Key Function:**
```javascript
validateTimeframeAnalysis(tfData, currentPrice)
```

**Validation Rules:**
1. **Market Structure:** Always exists with BOS/CHOCH (type: 'none' if no event)
2. **Volatility:** Always exists with state (never null)
3. **Volume Profile:** Always exists (empty arrays if no data)
4. **Liquidity Zones:** Always array (never null)
5. **Fair Value Gaps:** Always array (never null)
6. **Divergences:** Always array (never null)
7. **Volume:** Always structured object (never null)

**Critical:** This layer is the final safety net - it ensures no null values pass through.

---

### 7. Strategy Evaluation Layer

**Location:** `services/strategy.js`

**Responsibilities:**
- Evaluate all strategies (SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP)
- Calculate confidence with hierarchy (Macro, Primary, Execution)
- Compute HTF bias
- Build timeframe summary

**Key Functions:**
```javascript
evaluateAllStrategies(symbol, analysis, mode, marketData, dflowData)
buildTimeframeSummary(multiTimeframeData)
computeHTFBias(analysis)
```

**Output Structure:**
```javascript
{
  strategies: {
    SWING: { valid, direction, confidence, reason, entryZone, stopLoss, targets, ... },
    TREND_4H: { ... },
    ...
  },
  bestSignal: 'TREND_4H',
  overrideUsed: false,
  overrideNotes: [],
  confidenceBreakdown: { ... }
}
```

---

### 8. Timeframe Summary Builder

**Location:** `services/strategy.js` - `buildTimeframeSummary()`

**Responsibilities:**
- Merge all modules into timeframe object
- Apply structured fallbacks
- Normalize data format
- Ensure consistency

**Critical:** Uses structured fallbacks, never `|| null`:
```javascript
marketStructure: data.marketStructure || {
  currentStructure: 'unknown',
  lastSwings: [],
  lastBos: { type: 'none', direction: 'none', ... },
  lastChoch: { type: 'none', direction: 'none', ... }
}
```

---

### 9. Frontend Export Layer

**Location:** `public/index.html`

**Functions:**
- `buildRichSymbolFromScanResults()` - Builds rich symbol from scan results
- `copyCoinView()` - Exports single coin JSON
- `copyAllCoins()` - Exports all coins JSON

**Responsibilities:**
- Merge analysis into timeframes
- Apply structured fallbacks
- Ensure complete data structure
- Handle missing data gracefully

**Critical:** All export paths use structured fallbacks, never `|| null`.

---

## Data Structure Guarantees

### Per Timeframe Structure

Every timeframe in the final JSON **guarantees**:

```javascript
{
  trend: "up" | "down" | "flat",
  ema21: number | null,
  ema200: number | null,
  stochRsi: { k, d, state },
  rsi: { value, overbought, oversold, history } | null,
  candlestickPatterns: object | null,
  wickAnalysis: object | null,
  trendStrength: object | null,
  
  // ✅ ADVANCED MODULES - Always present (never null)
  marketStructure: {
    currentStructure: string,
    lastSwings: array,
    lastBos: { type, direction, ... },
    lastChoch: { type, direction, ... }
  },
  volatility: {
    atr: number | null,
    atrPctOfPrice: number | null,
    state: "low" | "normal" | "high" | "extreme"  // Never null
  },
  volume: {
    current: number,
    avg20: number,
    trend: "up" | "down" | "flat"
  },
  volumeProfile: {
    highVolumeNodes: array,
    lowVolumeNodes: array,
    valueAreaHigh: number | null,
    valueAreaLow: number | null
  },
  liquidityZones: array,  // Never null (empty array if none)
  fairValueGaps: array,  // Never null (empty array if none)
  divergences: array      // Never null (empty array if none)
}
```

---

## Module Calculation Requirements

### Minimum Candle Requirements

| Module | Minimum Candles | Fallback Behavior |
|--------|----------------|-------------------|
| Market Structure | 5 | Returns empty structure |
| Volume Profile | 3 | Returns empty structure |
| Liquidity Zones | 5 | Returns empty array |
| Fair Value Gaps | 3 | Returns empty array |
| Divergences | 5 | Returns empty array |
| ATR | 15 | Returns default volatility object |
| Volume Analysis | 1 | Returns structured object with defaults |

### Dynamic Adjustments

**Volume Profile Binning:**
```javascript
const numBins = Math.min(24, Math.max(3, Math.floor(candles.length / 3)), candles.length);
```
- Ensures `bins <= candleCount` to prevent empty profiles
- Minimum 3 bins, maximum 24 bins

**Liquidity Zones Tolerance:**
```javascript
const tolerance = candles.length < 20 ? 0.2 : 0.5;  // % price difference
```
- Lower timeframes use looser tolerance (0.2%)
- Higher timeframes use tighter tolerance (0.5%)

**Divergence Pivot Depth:**
```javascript
const pivotDepth = Math.max(1, Math.min(2, Math.floor(closes.length / 5)));
```
- Shallow pivots (1 candle) for short series
- Deeper pivots (2 candles) for longer series
- Fallback to 0-depth if needed

---

## Error Handling Strategy

### Three-Layer Fallback System

1. **Calculation Layer:** Module functions return structured objects/arrays
2. **Validation Layer:** `validateTimeframeAnalysis()` ensures all modules exist
3. **Export Layer:** Frontend functions apply final fallbacks

### Error Recovery

**If calculation fails:**
```javascript
try {
  result = calculateModule(candles);
} catch (error) {
  result = getDefaultModuleStructure();  // Never null
}
```

**If validation finds missing module:**
```javascript
if (!validated.module) {
  validated.module = getDefaultModuleStructure();
}
```

**If export finds missing module:**
```javascript
timeframes[tf].module = data.module || getDefaultModuleStructure();
```

---

## Adding New Modules

### Step 1: Create Calculation Function

**Location:** `lib/advancedChartAnalysis.js` (or new file)

```javascript
export function calculateNewModule(candles, indicators) {
  // Always return structured object/array, never null
  const defaultResult = {
    // ... default structure
  };
  
  if (!candles || candles.length < minCandles) {
    return defaultResult;
  }
  
  try {
    // ... calculation logic
    return result;
  } catch (error) {
    console.warn('[NewModule] Calculation error:', error.message);
    return defaultResult;
  }
}
```

### Step 2: Add to Advanced Chart Analysis

**Location:** `lib/advancedChartAnalysis.js` - `calculateAllAdvancedChartAnalysis()`

```javascript
export function calculateAllAdvancedChartAnalysis(candles, indicators, swingPoints, trend) {
  const result = {};
  
  // ... existing modules
  
  // New module
  try {
    const newModule = calculateNewModule(candles, indicators);
    result.newModule = newModule || getDefaultNewModuleStructure();
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] New module error:', error.message);
    result.newModule = getDefaultNewModuleStructure();
  }
  
  return result;
}
```

### Step 3: Add to API Endpoint

**Location:** `api/analyze-full.js`

```javascript
// In timeframe processing loop
const tfAnalysis = {
  // ... existing fields
  newModule: advancedChart.newModule || getDefaultNewModuleStructure()
};
```

### Step 4: Add Validation

**Location:** `lib/dataValidation.js` - `validateTimeframeAnalysis()`

```javascript
// Ensure newModule always exists
if (!validated.newModule) {
  validated.newModule = getDefaultNewModuleStructure();
}
```

### Step 5: Add to Timeframe Summary

**Location:** `services/strategy.js` - `buildTimeframeSummary()`

```javascript
timeframes[tf] = {
  // ... existing fields
  newModule: data.newModule || getDefaultNewModuleStructure()
};
```

### Step 6: Add to Frontend Export

**Location:** `public/index.html` - `buildRichSymbolFromScanResults()`

```javascript
timeframes[tf] = {
  // ... existing fields
  newModule: tfData.newModule || getDefaultNewModuleStructure()
};
```

---

## Performance Considerations

### Caching Strategy

- **Indicator calculations:** Cached per symbol/timeframe
- **Advanced modules:** Calculated on-demand
- **Strategy evaluation:** Recalculated on each request

### Optimization Tips

1. **Parallel Processing:** All timeframes calculated in parallel
2. **Early Returns:** Return defaults if insufficient data
3. **Lazy Loading:** Only calculate needed modules
4. **Data Validation:** Run validation once at end, not per module

---

## Testing Checklist

### Module Presence Test

```bash
curl "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, hasMS: (.value.marketStructure != null), hasVP: (.value.volumeProfile != null)})'
```

**Expected:** All timeframes show `hasMS: true, hasVP: true`

### Structure Consistency Test

```bash
curl "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["1m"] | {msType: (.marketStructure | type), vpType: (.volumeProfile | type), volType: (.volatility | type)}'
```

**Expected:** All types are `"object"` (never `"null"`)

### State Classification Test

```bash
curl "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, volState: .value.volatility.state})'
```

**Expected:** All timeframes have valid state: `"low" | "normal" | "high" | "extreme"`

---

## Troubleshooting

### Issue: Module returns null

**Check:**
1. Module function returns default structure on error
2. Validation layer ensures module exists
3. Export layer applies fallback

**Fix:**
```javascript
// In module function
return result || getDefaultStructure();  // Never null
```

### Issue: Volatility state is null

**Check:**
1. `calculateATR()` classifies state
2. `validateVolatility()` ensures state exists
3. API endpoint sets default state

**Fix:**
```javascript
// In validateVolatility
if (!fixed.state) {
  fixed.state = classifyVolatility(fixed.atrPctOfPrice);
}
```

### Issue: Volume Profile empty

**Check:**
1. Bins <= candleCount
2. Volume data exists
3. Price range valid

**Fix:**
```javascript
const numBins = Math.min(24, Math.floor(candles.length / 3), candles.length);
```

### Issue: Divergences always empty

**Check:**
1. Pivot detection working
2. RSI/StochRSI history available
3. Minimum requirements met

**Fix:**
- Reduce pivot depth
- Check indicator history length
- Verify pivot detection logic

---

## Best Practices

1. **Always return structured objects/arrays** - Never `null`
2. **Use three-layer fallback system** - Calculation → Validation → Export
3. **Log errors but don't fail** - Return defaults instead
4. **Test with low candle counts** - Ensure modules work with minimal data
5. **Validate at every layer** - Don't assume data exists
6. **Use consistent naming** - Follow existing patterns
7. **Document minimum requirements** - Update this doc when adding modules

---

## Related Documentation

- [Troubleshooting Guide](./TROUBLESHOOTING_GUIDE.md)
- [Strategy Integration Guide](./STRATEGY_INTEGRATION_GUIDE.md)
- [Module Development Guide](./MODULE_DEVELOPMENT_GUIDE.md)
- [API Reference](./API_REFERENCE.md)
