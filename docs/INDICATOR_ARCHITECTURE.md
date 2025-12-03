# Indicator Architecture Overview

This document explains how indicators flow through the entire system, from calculation to display to JSON export.

> **See Also:** `SYSTEM_WORKFLOW.md` for complete system workflow and how tweaking indicators affects strategies.

## Data Flow Diagram

```
OHLCV Candles (from Kraken API)
    ↓
services/indicators.js::calculateAllIndicators()
    ↓
Indicator Object Structure
    ↓
    ├─→ services/strategy.js (Strategy Evaluation)
    │   ├─→ Trend Detection
    │   ├─→ Confidence Scoring
    │   ├─→ Entry/Exit Logic
    │   └─→ Signal Generation
    │
    ├─→ api/analyze.js & api/analyze-full.js (API Endpoints)
    │   └─→ JSON Response Structure
    │
    ├─→ public/index.html (Frontend)
    │   ├─→ Details Row Display
    │   ├─→ Timeframe Cards
    │   └─→ JSON Export Functions
    │
    └─→ JSON Exports (Copy Buttons)
        ├─→ Single Coin View
        └─→ All Coins View
```

## Indicator Object Structure

All indicators are calculated in `services/indicators.js::calculateAllIndicators()` and return this structure:

```javascript
{
  price: {
    current: number,        // Current close price
    high: number,          // Highest high in dataset
    low: number            // Lowest low in dataset
  },
  ema: {
    ema21: number | null,           // Current 21 EMA value
    ema200: number | null,         // Current 200 EMA value
    ema21History: Array<number>,   // Full 21 EMA history
    ema200History: Array<number>   // Full 200 EMA history
  },
  stochRSI: {
    k: number | null,              // Current %K value (0-100)
    d: number | null,              // Current %D value (0-100)
    condition: string,             // 'OVERBOUGHT' | 'OVERSOLD' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    history: Array<{k, d}>         // Full StochRSI history
  },
  analysis: {
    trend: string,                // 'UPTREND' | 'DOWNTREND' | 'FLAT'
    pullbackState: string,         // 'ENTRY_ZONE' | 'RETRACING' | 'OVEREXTENDED' | 'UNKNOWN'
    distanceFrom21EMA: number | null // Percentage distance from 21 EMA
  },
  metadata: {
    candleCount: number,
    lastUpdate: string             // ISO timestamp
  }
}
```

## Integration Points

### 1. Calculation Layer (`services/indicators.js`)

**File:** `services/indicators.js`

**Key Function:** `calculateAllIndicators(candles)`

This is where all indicators are calculated from raw OHLCV candle data. Each indicator should:
- Have its own calculation function (e.g., `calculateEMA21`, `calculateEMA200`)
- Handle errors gracefully (return `null` if insufficient data)
- Return current value and history (if applicable)
- Be integrated into the main `calculateAllIndicators()` function

**Example:**
```javascript
// Individual calculation function
export function calculateEMA50(prices) {
  if (prices.length < 50) {
    throw new Error('Not enough data points for 50 EMA');
  }
  return EMA.calculate({ period: 50, values: prices });
}

// Integration in calculateAllIndicators()
let ema50;
try {
  ema50 = calculateEMA50(closes);
} catch (error) {
  ema50 = null;
}

// Add to return object
return {
  // ... existing indicators
  ema: {
    ema21: currentEMA21,
    ema200: currentEMA200,
    ema50: ema50 ? ema50[ema50.length - 1] : null,  // NEW
    ema50History: ema50,  // NEW
    // ... rest of ema object
  }
};
```

### 2. Strategy Evaluation Layer (`services/strategy.js`)

**File:** `services/strategy.js`

**Key Functions:**
- `evaluateStrategy()` - Main strategy evaluation
- `calculateConfidenceWithHierarchy()` - Confidence scoring
- `calculateConfidence()` - Legacy confidence calculation

Indicators are accessed via:
```javascript
const tf4h = analysis['4h'];
const ema21 = tf4h.indicators.ema.ema21;
const trend = tf4h.indicators.analysis.trend;
const stoch = tf4h.indicators.stochRSI;
```

**Usage Patterns:**
1. **Trend Detection:** Uses `indicators.analysis.trend`
2. **Entry Logic:** Uses `indicators.ema.ema21` for entry zones
3. **Confidence Scoring:** Uses multiple indicators across timeframes
4. **Signal Validation:** Checks indicator alignment

**Example Integration:**
```javascript
// In evaluateStrategy() or confidence calculation
const ema50 = tf4h.indicators.ema.ema50;  // NEW indicator
if (ema50 && currentPrice > ema50) {
  // Price above 50 EMA - bullish signal
  score += 0.05;
}
```

### 3. API Endpoints (`api/analyze.js`, `api/analyze-full.js`)

**Files:** `api/analyze.js`, `api/analyze-full.js`

These endpoints:
1. Fetch OHLCV data via `marketData.getMultiTimeframeData()`
2. Calculate indicators via `indicatorService.calculateAllIndicators()`
3. Pass indicator data to strategy evaluation
4. Return indicators in JSON response

**Indicator Data in API Response:**
```javascript
{
  analysis: {
    '4h': {
      indicators: { /* full indicator object */ },
      structure: { swingHigh, swingLow },
      candleCount: number
    },
    // ... other timeframes
  }
}
```

### 4. Frontend Display (`public/index.html`)

**File:** `public/index.html`

**Key Functions:**
- `createDetailsRow()` - Creates detailed timeframe breakdown (line ~2963)
- `buildRichSymbolFromScanResults()` - Builds JSON for export (line ~4023)

**Display Locations:**

1. **Details Row (Timeframe Cards):**
   - Shows indicators per timeframe
   - Located in `createDetailsRow()` function
   - Displays: trend, EMA values, StochRSI, pullback state

2. **JSON Export:**
   - Includes indicators in `timeframes` object
   - Located in `buildRichSymbolFromScanResults()` and related functions
   - Structure matches API response format

**Example Frontend Integration:**
```javascript
// In createDetailsRow() - timeframe card display
const ema50 = ind.ema?.ema50 || null;  // NEW
${ema50 ? `
  <div class="flex justify-between mb-1">
    <span style="color: var(--color-yellow-75); opacity: 0.6;">50 EMA</span>
    <span class="font-bold" style="color: var(--color-yellow-75);">$${ema50.toLocaleString()}</span>
  </div>
` : ''}

// In buildRichSymbolFromScanResults() - JSON export
timeframes[tf] = {
  trend: ...,
  ema21: ...,
  ema200: ...,
  ema50: tfData.indicators.ema?.ema50 || null,  // NEW
  // ... rest of timeframe data
};
```

## Indicator Propagation Path

When you add a new indicator, it must flow through these steps:

1. **Calculation** (`services/indicators.js`)
   - Add calculation function
   - Integrate into `calculateAllIndicators()`
   - Add to return object structure

2. **Strategy Usage** (`services/strategy.js`)
   - Access via `analysis[tf].indicators.yourIndicator`
   - Use in trend detection, confidence scoring, or entry logic
   - Update any relevant strategy rules

3. **API Response** (automatic)
   - Already included if added to `calculateAllIndicators()`
   - Available in `analysis[tf].indicators` object

4. **Frontend Display** (`public/index.html`)
   - Add to `createDetailsRow()` timeframe cards
   - Add to `buildRichSymbolFromScanResults()` JSON export
   - Add to any other display functions

5. **JSON Export** (automatic if step 4 done)
   - Included in copy button exports
   - Available in all JSON structures

## Key Principles

1. **Single Source of Truth:** All indicators calculated in `services/indicators.js`
2. **Consistent Structure:** All indicators follow the same object pattern
3. **Error Handling:** Always handle null/undefined values gracefully
4. **Backward Compatibility:** New indicators should not break existing code
5. **Documentation:** Update this file when adding new indicators

## Current Indicators

- **EMA21:** Exponential Moving Average (21 period)
- **EMA200:** Exponential Moving Average (200 period)
- **Stochastic RSI:** Momentum oscillator (14, 14, 3, 3)
- **Trend:** Derived from EMA alignment (price > EMA21 > EMA200)
- **Pullback State:** Distance from 21 EMA (ENTRY_ZONE, RETRACING, OVEREXTENDED)
- **Swing Points:** Market structure (swing high/low)

See `INDICATOR_REFERENCE.md` for detailed specifications of each indicator.

