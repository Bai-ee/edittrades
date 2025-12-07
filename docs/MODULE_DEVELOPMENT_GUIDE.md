# Module Development Guide

**Last Updated:** 2025-01-XX  
**Status:** Production Ready  
**Milestone Tag:** `v1.0-data-parity`

---

## Overview

This guide explains how to add new analysis modules to the system. All modules must follow strict consistency rules to ensure reliable data structure across all timeframes.

---

## Module Development Checklist

- [ ] Module function returns structured object/array (never null)
- [ ] Minimum candle requirements documented
- [ ] Fallback structure defined
- [ ] Added to `calculateAllAdvancedChartAnalysis()`
- [ ] Added to API endpoint (`analyze-full.js`)
- [ ] Added to validation layer (`dataValidation.js`)
- [ ] Added to timeframe summary (`buildTimeframeSummary()`)
- [ ] Added to frontend export (`buildRichSymbolFromScanResults()`)
- [ ] Tested with low candle counts
- [ ] Tested across all timeframes
- [ ] Documentation updated

---

## Module Template

### Basic Structure

```javascript
/**
 * Calculate [Module Name]
 * @param {Array} candles - OHLCV array
 * @param {Object} indicators - Existing indicators (optional)
 * @param {Object} swingPoints - Existing swing points (optional)
 * @returns {Object|Array} Module result (never null)
 */
export function calculateNewModule(candles, indicators = null, swingPoints = null) {
  // 1. Define default structure (ALWAYS)
  const defaultResult = {
    // ... default structure
  };
  
  // 2. Early return with default if insufficient data
  if (!candles || candles.length < minCandles) {
    return defaultResult;  // Never null
  }
  
  // 3. Validate input data
  if (!hasRequiredData(candles)) {
    return defaultResult;
  }
  
  // 4. Try calculation
  try {
    // ... calculation logic
    
    // 5. Validate result
    if (!isValidResult(result)) {
      return defaultResult;
    }
    
    return result;
  } catch (error) {
    console.warn('[NewModule] Calculation error:', error.message);
    return defaultResult;  // Never null, always return default
  }
}
```

---

## Step-by-Step: Adding a New Module

### Example: Adding "Order Flow" Module

### Step 1: Create Module File

**Location:** `lib/orderFlowAnalysis.js` (new file)

```javascript
/**
 * Order Flow Analysis Module
 * 
 * Analyzes order flow patterns and imbalances
 */

/**
 * Calculate order flow analysis
 * @param {Array} candles - OHLCV array
 * @param {Object} marketData - Market data (optional)
 * @returns {Object} Order flow analysis (never null)
 */
export function calculateOrderFlow(candles, marketData = null) {
  // Always return structured object, never null
  const defaultOrderFlow = {
    buyPressure: 0,
    sellPressure: 0,
    imbalance: 0,
    flowDirection: 'neutral',
    significantLevels: []
  };
  
  if (!candles || candles.length < 10) {
    return defaultOrderFlow;
  }
  
  try {
    // Calculation logic
    const buyPressure = calculateBuyPressure(candles);
    const sellPressure = calculateSellPressure(candles);
    const imbalance = buyPressure - sellPressure;
    
    let flowDirection = 'neutral';
    if (imbalance > 0.1) {
      flowDirection = 'bullish';
    } else if (imbalance < -0.1) {
      flowDirection = 'bearish';
    }
    
    return {
      buyPressure: parseFloat(buyPressure.toFixed(2)),
      sellPressure: parseFloat(sellPressure.toFixed(2)),
      imbalance: parseFloat(imbalance.toFixed(2)),
      flowDirection,
      significantLevels: findSignificantLevels(candles)
    };
  } catch (error) {
    console.warn('[OrderFlow] Calculation error:', error.message);
    return defaultOrderFlow;
  }
}
```

### Step 2: Add to Advanced Chart Analysis

**Location:** `lib/advancedChartAnalysis.js`

```javascript
import { calculateOrderFlow } from './orderFlowAnalysis.js';

export function calculateAllAdvancedChartAnalysis(candles, indicators, swingPoints, trend) {
  const result = {};
  
  // ... existing modules
  
  // Order Flow - Always include (even if null)
  try {
    const orderFlow = calculateOrderFlow(candles, null);
    result.orderFlow = orderFlow || {
      buyPressure: 0,
      sellPressure: 0,
      imbalance: 0,
      flowDirection: 'neutral',
      significantLevels: []
    };
  } catch (error) {
    console.warn('[AdvancedChartAnalysis] Order flow error:', error.message);
    result.orderFlow = {
      buyPressure: 0,
      sellPressure: 0,
      imbalance: 0,
      flowDirection: 'neutral',
      significantLevels: []
    };
  }
  
  return result;
}
```

### Step 3: Add to API Endpoint

**Location:** `api/analyze-full.js`

```javascript
// In timeframe processing loop
const advancedChart = advancedChartAnalysis.calculateAllAdvancedChartAnalysis(
  candles,
  indicators,
  swingPoints,
  trend
);

// Build analysis object
const tfAnalysis = {
  // ... existing fields
  orderFlow: advancedChart.orderFlow || {
    buyPressure: 0,
    sellPressure: 0,
    imbalance: 0,
    flowDirection: 'neutral',
    significantLevels: []
  }
};
```

### Step 4: Add Validation

**Location:** `lib/dataValidation.js`

```javascript
export function validateOrderFlow(orderFlow) {
  if (!orderFlow || typeof orderFlow !== 'object') {
    return {
      buyPressure: 0,
      sellPressure: 0,
      imbalance: 0,
      flowDirection: 'neutral',
      significantLevels: []
    };
  }
  
  const fixed = { ...orderFlow };
  
  // Validate flowDirection enum
  if (!['bullish', 'bearish', 'neutral'].includes(fixed.flowDirection)) {
    fixed.flowDirection = 'neutral';
  }
  
  // Validate significantLevels is array
  if (!Array.isArray(fixed.significantLevels)) {
    fixed.significantLevels = [];
  }
  
  return fixed;
}

// In validateTimeframeAnalysis()
export function validateTimeframeAnalysis(tfData, currentPrice) {
  // ... existing validations
  
  // Validate order flow - Always ensure it exists
  if (validated.orderFlow) {
    validated.orderFlow = validateOrderFlow(validated.orderFlow);
  } else {
    validated.orderFlow = {
      buyPressure: 0,
      sellPressure: 0,
      imbalance: 0,
      flowDirection: 'neutral',
      significantLevels: []
    };
  }
  
  return validated;
}
```

### Step 5: Add to Timeframe Summary

**Location:** `services/strategy.js` - `buildTimeframeSummary()`

```javascript
timeframes[tf] = {
  // ... existing fields
  orderFlow: data.orderFlow || {
    buyPressure: 0,
    sellPressure: 0,
    imbalance: 0,
    flowDirection: 'neutral',
    significantLevels: []
  }
};
```

### Step 6: Add to Frontend Export

**Location:** `public/index.html` - `buildRichSymbolFromScanResults()`

```javascript
timeframes[tf] = {
  // ... existing fields
  orderFlow: tfData.orderFlow || {
    buyPressure: 0,
    sellPressure: 0,
    imbalance: 0,
    flowDirection: 'neutral',
    significantLevels: []
  }
};
```

### Step 7: Test Module

```bash
# Test module presence
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, hasOrderFlow: (.value.orderFlow != null)})'

# Test module structure
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["4h"].orderFlow'

# Test with low candle count
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["1m"] | {candleCount, orderFlow: .orderFlow}'
```

---

## Module Types

### Type 1: Object Module (e.g., Market Structure, Volume Profile)

**Returns:** Structured object

**Rules:**
- Always return object, never `null`
- Include all required fields
- Use `null` for optional numeric fields
- Use empty arrays for optional array fields

**Example:**
```javascript
{
  field1: value,
  field2: value | null,
  field3: [],
  nested: {
    subfield1: value,
    subfield2: value | null
  }
}
```

### Type 2: Array Module (e.g., Liquidity Zones, FVGs, Divergences)

**Returns:** Array

**Rules:**
- Always return array, never `null`
- Empty array `[]` if no data
- Each element must have consistent structure

**Example:**
```javascript
[
  { field1: value, field2: value },
  { field1: value, field2: value }
]
```

---

## Dynamic Adjustments

### Candle Count Based Adjustments

```javascript
// Adjust parameters based on available candles
const lookback = Math.min(100, candles.length);
const period = Math.min(20, Math.floor(candles.length / 2));
const tolerance = candles.length < 20 ? 0.2 : 0.5;
```

### Timeframe Based Adjustments

```javascript
// Adjust for timeframe characteristics
const isLowerTF = ['1m', '3m', '5m'].includes(timeframe);
const tolerance = isLowerTF ? 0.2 : 0.5;
const minCandles = isLowerTF ? 5 : 10;
```

---

## Error Handling

### Three-Layer Error Handling

1. **Module Level:** Return default structure on error
2. **Validation Level:** Ensure module exists
3. **Export Level:** Apply final fallback

### Error Handling Pattern

```javascript
export function calculateModule(candles) {
  const defaultResult = getDefaultStructure();
  
  if (!candles || candles.length < minCandles) {
    return defaultResult;
  }
  
  try {
    // Calculation
    return result;
  } catch (error) {
    console.warn('[Module] Error:', error.message);
    console.error('[Module] Stack:', error.stack);
    return defaultResult;  // Always return default
  }
}
```

---

## Performance Considerations

### Optimization Tips

1. **Early Returns:** Return defaults immediately if insufficient data
2. **Lazy Calculation:** Only calculate if needed
3. **Caching:** Cache expensive calculations
4. **Parallel Processing:** Calculate independent modules in parallel

### Memory Management

```javascript
// Use slice() to limit lookback
const lookback = Math.min(100, candles.length);
const recentCandles = candles.slice(-lookback);

// Clean up large arrays
const result = processData(recentCandles);
recentCandles = null;  // Help GC
```

---

## Testing New Modules

### Unit Test

```javascript
import { calculateNewModule } from './lib/newModule.js';

// Test with sufficient data
const candles = generateMockCandles(50);
const result = calculateNewModule(candles);
assert(result !== null);
assert(result.field1 !== undefined);

// Test with insufficient data
const fewCandles = generateMockCandles(3);
const result2 = calculateNewModule(fewCandles);
assert(result2 !== null);  // Should return default
assert(result2.field1 !== undefined);

// Test with invalid data
const invalidCandles = null;
const result3 = calculateNewModule(invalidCandles);
assert(result3 !== null);  // Should return default
```

### Integration Test

```bash
# Test module in full pipeline
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, module: .value.newModule})'

# Test across all timeframes
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, hasModule: (.value.newModule != null), moduleType: (.value.newModule | type)})'
```

---

## Common Patterns

### Pattern 1: Price-Based Analysis

```javascript
export function calculatePriceBasedModule(candles) {
  const defaultResult = { levels: [], zones: [] };
  
  if (!candles || candles.length < 10) {
    return defaultResult;
  }
  
  const prices = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  // Analysis based on price action
  const levels = findPriceLevels(highs, lows);
  const zones = findPriceZones(prices);
  
  return {
    levels: levels || [],
    zones: zones || []
  };
}
```

### Pattern 2: Indicator-Based Analysis

```javascript
export function calculateIndicatorBasedModule(candles, indicators) {
  const defaultResult = { signals: [], strength: 0 };
  
  if (!candles || !indicators) {
    return defaultResult;
  }
  
  const rsi = indicators.rsi;
  const stoch = indicators.stochRSI;
  
  if (!rsi || !stoch) {
    return defaultResult;
  }
  
  // Analysis based on indicators
  const signals = findSignals(rsi, stoch);
  const strength = calculateStrength(signals);
  
  return {
    signals: signals || [],
    strength: strength || 0
  };
}
```

### Pattern 3: Volume-Based Analysis

```javascript
export function calculateVolumeBasedModule(candles) {
  const defaultResult = { patterns: [], trend: 'neutral' };
  
  if (!candles || candles.length < 20) {
    return defaultResult;
  }
  
  // Check for volume data
  const hasVolume = candles.some(c => c.volume && c.volume > 0);
  if (!hasVolume) {
    return defaultResult;
  }
  
  const volumes = candles.map(c => c.volume);
  const patterns = findVolumePatterns(volumes);
  const trend = calculateVolumeTrend(volumes);
  
  return {
    patterns: patterns || [],
    trend: trend || 'neutral'
  };
}
```

---

## Documentation Requirements

When adding a new module, document:

1. **Purpose:** What does the module analyze?
2. **Inputs:** What data does it need?
3. **Outputs:** What structure does it return?
4. **Minimum Requirements:** Minimum candles/data points needed
5. **Fallback Behavior:** What happens with insufficient data?
6. **Usage Examples:** How to use in strategies
7. **Performance Notes:** Any performance considerations

---

## Related Documentation

- [Data Pipeline Architecture](./DATA_PIPELINE_ARCHITECTURE.md)
- [Strategy Integration Guide](./STRATEGY_INTEGRATION_GUIDE.md)
- [Troubleshooting Guide](./TROUBLESHOOTING_GUIDE.md)
