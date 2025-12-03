# Adding New Indicators - Step-by-Step Guide

This guide walks you through adding a new indicator to the system. We'll use **50 EMA** as a complete example.

> **See Also:** `SYSTEM_WORKFLOW.md` for complete system workflow and how tweaking indicators affects strategies.

## Prerequisites

- Understand the indicator calculation
- Know which timeframes it applies to
- Determine how it affects strategy logic
- Decide on display format

## Step-by-Step Process

### Step 1: Add Calculation Function

**File:** `services/indicators.js`

**Action:** Create the calculation function

```javascript
/**
 * Calculate 50 EMA from price data
 * @param {Array<number>} prices - Array of close prices
 * @returns {Array<number>} EMA values
 */
export function calculateEMA50(prices) {
  if (prices.length < 50) {
    throw new Error('Not enough data points for 50 EMA (need at least 50)');
  }

  return EMA.calculate({
    period: 50,
    values: prices
  });
}
```

**Checklist:**
- [ ] Function follows naming convention: `calculate[IndicatorName]`
- [ ] Includes JSDoc comment
- [ ] Validates minimum data requirements
- [ ] Uses appropriate library (technicalindicators)
- [ ] Exported from module

### Step 2: Integrate into calculateAllIndicators()

**File:** `services/indicators.js`

**Location:** Inside `calculateAllIndicators()` function (around line 73)

**Action:** Add calculation and error handling

```javascript
// Calculate EMAs
let ema21, ema200, ema50;  // ADD ema50
try {
  ema21 = calculateEMA21(closes);
} catch (error) {
  ema21 = null;
}

try {
  ema200 = calculateEMA200(closes);
} catch (error) {
  ema200 = null;
}

// ADD THIS BLOCK
try {
  ema50 = calculateEMA50(closes);
} catch (error) {
  ema50 = null;
}
```

**Action:** Extract current value

```javascript
// Get current values (last element)
const currentPrice = closes[closes.length - 1];
const currentEMA21 = ema21 ? ema21[ema21.length - 1] : null;
const currentEMA200 = ema200 ? ema200[ema200.length - 1] : null;
const currentEMA50 = ema50 ? ema50[ema50.length - 1] : null;  // ADD THIS
```

**Action:** Add to return object

```javascript
return {
  price: { /* ... */ },
  ema: {
    ema21: currentEMA21,
    ema200: currentEMA200,
    ema50: currentEMA50,              // ADD THIS
    ema21History: ema21,
    ema200History: ema200,
    ema50History: ema50,              // ADD THIS
  },
  stochRSI: { /* ... */ },
  analysis: { /* ... */ },
  metadata: { /* ... */ }
};
```

**Checklist:**
- [ ] Calculation added with try/catch
- [ ] Current value extracted
- [ ] Added to return object structure
- [ ] History included (if applicable)

### Step 3: Update Strategy Evaluation (Optional)

**File:** `services/strategy.js`

**When to do this:** Only if the indicator affects trade signals or confidence scoring.

**Example 1: Using in Trend Detection**

```javascript
// In evaluateStrategy() or similar function
const tf4h = analysis['4h'];
const ema50 = tf4h.indicators.ema.ema50;

// Use in logic
if (ema50 && currentPrice > ema50 && currentPrice > ema21) {
  // Strong bullish alignment
  confidence += 5;
}
```

**Example 2: Using in Confidence Calculation**

```javascript
// In calculateConfidence() or calculateConfidenceWithHierarchy()
const ema50 = tf4h.indicators.ema.ema50;
if (direction === 'long' && ema50 && currentPrice > ema50) {
  score += 0.05;  // Bonus for price above 50 EMA
}
```

**Checklist:**
- [ ] Indicator accessed via `analysis[tf].indicators.yourIndicator`
- [ ] Null checks included
- [ ] Logic aligns with strategy rules
- [ ] Confidence scoring updated (if applicable)

### Step 4: Add to Frontend Display

**File:** `public/index.html`

**Location 1:** `createDetailsRow()` function (around line 2963)

**Action:** Add to timeframe card display

```javascript
// Inside the timeframe card template (around line 2993)
${ind.ema?.ema50 ? `
  <div class="flex justify-between mb-1">
    <span style="color: var(--color-yellow-75); opacity: 0.6;">50 EMA</span>
    <span class="font-bold" style="color: var(--color-yellow-75);">$${ind.ema.ema50.toLocaleString()}</span>
  </div>
` : ''}
```

**Location 2:** `buildRichSymbolFromScanResults()` function (around line 4023)

**Action:** Add to JSON export structure

```javascript
// Inside the timeframes loop (around line 4033)
timeframes[tf] = {
  trend: (tfData.indicators.analysis?.trend || 'UNKNOWN').toLowerCase(),
  ema21: tfData.indicators.ema?.ema21 || null,
  ema200: tfData.indicators.ema?.ema200 || null,
  ema50: tfData.indicators.ema?.ema50 || null,  // ADD THIS
  stochRsi: { /* ... */ },
  // ... rest of structure
};
```

**Location 3:** Other JSON export functions (if any)

Search for other places where timeframe data is exported and add the indicator there too.

**Checklist:**
- [ ] Added to `createDetailsRow()` timeframe cards
- [ ] Added to `buildRichSymbolFromScanResults()` JSON export
- [ ] Added to any other export functions
- [ ] Null checks included in display
- [ ] Formatting consistent with other indicators

### Step 5: Update Export Default

**File:** `services/indicators.js`

**Action:** Add to default export (if using default export)

```javascript
export default {
  calculateEMA21,
  calculateEMA200,
  calculateEMA50,  // ADD THIS
  calculateStochasticRSI,
  calculateAllIndicators,
  detectSwingPoints,
  detectWickRejection
};
```

**Checklist:**
- [ ] Function exported (if using named exports, already done)
- [ ] Added to default export object (if applicable)

### Step 6: Testing

**Test Checklist:**

1. **Calculation Test:**
   - [ ] Indicator calculates correctly with sufficient data
   - [ ] Returns null gracefully with insufficient data
   - [ ] No errors in console

2. **Strategy Test:**
   - [ ] Indicator accessible in strategy evaluation
   - [ ] Strategy logic works correctly
   - [ ] Confidence scores reasonable

3. **Display Test:**
   - [ ] Indicator shows in details row
   - [ ] Formatting looks correct
   - [ ] Null values handled gracefully

4. **JSON Export Test:**
   - [ ] Indicator included in single coin copy
   - [ ] Indicator included in all coins copy
   - [ ] JSON structure valid
   - [ ] Values match displayed values

5. **Integration Test:**
   - [ ] All timeframes work (if applicable)
   - [ ] No breaking changes to existing features
   - [ ] Mobile display works correctly

## Complete Example: 50 EMA

See `docs/templates/indicator-calculation-template.js` for the complete code example.

## Common Patterns

### Pattern 1: Simple Moving Average Indicator

```javascript
// 1. Calculation function
export function calculateSMA50(prices) {
  if (prices.length < 50) throw new Error('Not enough data');
  return SMA.calculate({ period: 50, values: prices });
}

// 2. Integration
let sma50;
try { sma50 = calculateSMA50(closes); } catch { sma50 = null; }

// 3. Return object
return {
  // ...
  sma: {
    sma50: sma50 ? sma50[sma50.length - 1] : null,
    sma50History: sma50
  }
};
```

### Pattern 2: Derived Indicator (from existing)

```javascript
// Example: EMA50 position relative to price
// In calculateAllIndicators(), after calculating ema50:
let ema50Position = null;
if (currentEMA50) {
  ema50Position = currentPrice > currentEMA50 ? 'ABOVE' : 'BELOW';
}

// Add to return object
return {
  // ...
  analysis: {
    trend,
    pullbackState,
    distanceFrom21EMA,
    ema50Position  // NEW
  }
};
```

### Pattern 3: Multi-Timeframe Indicator

Some indicators only make sense on certain timeframes. Handle this in the calculation:

```javascript
// Example: VWAP only on intraday timeframes
const intradayTfs = ['1m', '3m', '5m', '15m', '1h'];
if (intradayTfs.includes(timeframe)) {
  // Calculate VWAP
} else {
  // Skip or return null
}
```

## Troubleshooting

### Indicator not showing in frontend
- Check that it's added to `createDetailsRow()`
- Verify null checks are correct
- Check browser console for errors

### Indicator not in JSON export
- Verify it's in `buildRichSymbolFromScanResults()`
- Check that the indicator path matches calculation structure
- Test the copy button and inspect JSON

### Strategy not using indicator
- Verify access path: `analysis[tf].indicators.yourIndicator`
- Check null handling
- Add console.log to debug

### Calculation errors
- Verify minimum data requirements
- Check library import
- Ensure error handling with try/catch

## Next Steps

After adding an indicator:

1. Update `INDICATOR_REFERENCE.md` with new indicator specs
2. Update `INDICATOR_ARCHITECTURE.md` if structure changes
3. Test thoroughly across all timeframes
4. Document any strategy logic changes

## Quick Reference

- **Calculation:** `services/indicators.js` → `calculateAllIndicators()`
- **Strategy:** `services/strategy.js` → `evaluateStrategy()` or confidence functions
- **Display:** `public/index.html` → `createDetailsRow()` (line ~2963)
- **Export:** `public/index.html` → `buildRichSymbolFromScanResults()` (line ~4023)

See `INDICATOR_INTEGRATION_CHECKLIST.md` for a quick checklist version of this guide.

