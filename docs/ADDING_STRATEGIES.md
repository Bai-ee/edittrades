# Adding New Strategies - Best Practices Guide

This guide provides a systematic approach to adding new trading strategies to the system without breaking existing functionality.

**Related Documentation:**
- `SYSTEM_WORKFLOW.md` - Complete system workflow and element impact guide
- `STRATEGY_IMPLEMENTATION_GUIDE.md` - Current strategies reference
- `INDICATOR_ARCHITECTURE.md` - Indicator system overview
- `INDICATOR_INTEGRATION_CHECKLIST.md` - Indicator integration guide

---

## Prerequisites

Before adding a new strategy:

1. **Define Strategy Rules:**
   - Timeframes required
   - Gatekeepers (when strategy is allowed)
   - Entry requirements (LONG and SHORT)
   - Stop loss logic
   - Target calculation (R:R ratios)
   - Confidence scoring method

2. **Determine Integration Points:**
   - Where in priority order?
   - STANDARD mode only or also AGGRESSIVE?
   - Does it need special mode handling?

3. **Plan Data Requirements:**
   - Which indicators are needed?
   - Which timeframes must be available?
   - What's the minimum data requirement?

---

## Step-by-Step Integration Process

### Step 1: Create Strategy Evaluation Function

**File:** `services/strategy.js`

**Template:**
```javascript
/**
 * Evaluate [Strategy Name] Setup
 * [Brief description of strategy logic]
 * @param {Object} multiTimeframeData - All timeframe data
 * @param {number} currentPrice - Current market price
 * @param {string} mode - STANDARD or AGGRESSIVE
 * @returns {Object|null} Strategy signal or null
 */
function evaluate[StrategyName](multiTimeframeData, currentPrice, mode = 'STANDARD') {
  // 1. Extract required timeframe data
  const tf[Primary] = multiTimeframeData['[primary-tf]'];
  const tf[Secondary] = multiTimeframeData['[secondary-tf]'];
  
  // Guard: Need all required timeframes
  if (!tf[Primary] || !tf[Secondary]) {
    return null;
  }
  
  // 2. Extract indicators
  const trend[Primary] = tf[Primary].indicators?.analysis?.trend;
  const ema21[Primary] = tf[Primary].indicators?.ema?.ema21;
  // ... other indicators
  
  // Guard: Need all data points
  if (!trend[Primary] || !ema21[Primary]) {
    return null;
  }
  
  // 3. GATEKEEPERS - When strategy is even allowed
  if (trend[Primary] === 'FLAT') {
    return null;  // Strategy blocked
  }
  
  // ... other gatekeepers
  
  // 4. ENTRY REQUIREMENTS (LONG)
  let direction = null;
  let reason = '';
  
  if (trend[Primary] === 'UPTREND' && /* other conditions */) {
    direction = 'long';
    reason = '[Description of why this is a long setup]';
  }
  
  // 5. ENTRY REQUIREMENTS (SHORT)
  if (!direction && trend[Primary] === 'DOWNTREND' && /* other conditions */) {
    direction = 'short';
    reason = '[Description of why this is a short setup]';
  }
  
  // If no valid direction, return null
  if (!direction) {
    return null;
  }
  
  // 6. ENTRY ZONE CALCULATION
  const entryZone = calculateEntryZone(ema21[Primary], direction);
  // OR custom calculation:
  // const entryMin = /* custom logic */;
  // const entryMax = /* custom logic */;
  
  // 7. STOP LOSS CALCULATION
  const allStructures = {
    '[tf1]': tf[Primary].structure || { swingHigh: null, swingLow: null },
    '[tf2]': tf[Secondary].structure || { swingHigh: null, swingLow: null }
  };
  
  const sltp = calculateSLTP(
    (entryZone.min + entryZone.max) / 2,
    direction,
    allStructures,
    '[StrategyName]',  // setupType
    [rrTarget1, rrTarget2]  // R:R targets
  );
  
  // 8. CONFIDENCE SCORING
  const confidenceResult = calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode);
  let confidence = confidenceResult.confidence;
  
  // Strategy-specific bonuses/penalties
  // confidence = Math.min(90, confidence + bonus);
  
  // 9. BUILD SIGNAL
  const htfBias = computeHTFBias(multiTimeframeData);
  
  return {
    valid: true,
    direction: direction,
    setupType: '[StrategyName]',
    selectedStrategy: '[STRATEGY_NAME]',
    strategiesChecked: ['[STRATEGY_NAME]'],
    confidence: Math.round(confidence),
    reason: reason,
    reason_summary: confidenceResult.explanation ? 
      `${reason} [${confidenceResult.explanation}]` : reason,
    penaltiesApplied: confidenceResult.penaltiesApplied,
    capsApplied: confidenceResult.capsApplied,
    explanation: confidenceResult.explanation,
    entryZone: {
      min: parseFloat(entryZone.min.toFixed(2)),
      max: parseFloat(entryZone.max.toFixed(2))
    },
    stopLoss: parseFloat(sltp.stopLoss.toFixed(2)),
    invalidationLevel: parseFloat(sltp.invalidationLevel.toFixed(2)),
    targets: sltp.targets.map(t => parseFloat(t.toFixed(2))),
    riskReward: {
      tp1RR: sltp.rrTargets[0],
      tp2RR: sltp.rrTargets[1]
    },
    riskAmount: parseFloat(sltp.riskAmount.toFixed(2)),
    invalidation: {
      level: parseFloat(sltp.invalidationLevel.toFixed(2)),
      description: '[Invalidation description]'
    },
    confluence: {
      trendAlignment: `[Description]`,
      stochMomentum: `[Description]`,
      pullbackState: `[Description]`,
      liquidityZones: `[Description]`,
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },
    conditionsRequired: [
      '✓ [Condition 1]',
      '✓ [Condition 2]',
      // ... all conditions
    ],
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString(),
    htfBias: htfBias
  };
}
```

**Checklist:**
- [ ] Function follows naming convention: `evaluate[StrategyName]`
- [ ] Includes JSDoc comment
- [ ] Validates all required timeframes
- [ ] Validates all required indicators
- [ ] Gatekeepers clearly defined
- [ ] Entry requirements for both LONG and SHORT
- [ ] Uses `calculateEntryZone()` or custom logic
- [ ] Uses `calculateSLTP()` with appropriate setupType
- [ ] Uses hierarchical confidence system
- [ ] Returns canonical signal structure
- [ ] Includes all required fields

---

### Step 2: Integrate into Main Evaluation Function

**File:** `services/strategy.js`  
**Function:** `evaluateStrategy()` (line ~1283)

**Action:** Add to priority order

```javascript
export function evaluateStrategy(symbol, multiTimeframeData, setupType = '4h', mode = 'STANDARD') {
  // ... existing code ...
  
  // PRIORITY 1: Check for Swing Setup
  if (setupType === 'Swing' || setupType === 'auto') {
    const swingSignal = evaluateSwingSetup(analysis, currentPrice);
    if (swingSignal && swingSignal.valid) {
      return normalizeToCanonical(swingSignal, analysis, mode);
    }
  }
  
  // PRIORITY 2: Check for [Your Strategy] (ADD HERE)
  if (setupType === '[YourStrategy]' || setupType === 'auto') {
    const yourStrategySignal = evaluate[StrategyName](analysis, currentPrice, mode);
    if (yourStrategySignal && yourStrategySignal.valid) {
      return normalizeToCanonical(yourStrategySignal, analysis, mode);
    }
  }
  
  // PRIORITY 3: Check for 4H Trend Play
  // ... existing code ...
  
  // PRIORITY 4: Check for Scalp
  // ... existing code ...
}
```

**Checklist:**
- [ ] Added to appropriate priority position
- [ ] Handles both explicit setupType and 'auto'
- [ ] Returns normalized canonical structure
- [ ] Priority order makes logical sense

---

### Step 3: Add to evaluateAllStrategies()

**File:** `services/strategy.js`  
**Function:** `evaluateAllStrategies()` (line ~2029)

**Action:** Add to strategies object and evaluation list

```javascript
export function evaluateAllStrategies(symbol, multiTimeframeData, mode = 'STANDARD') {
  const strategies = {
    SWING: null,
    TREND_4H: null,
    SCALP_1H: null,
    MICRO_SCALP: null,
    [STRATEGY_NAME]: null  // ADD THIS
  };
  
  // ... existing evaluation code ...
  
  // Evaluate [Your Strategy]
  const [strategyName]Signal = evaluate[StrategyName](multiTimeframeData, currentPrice, mode);
  strategies.[STRATEGY_NAME] = normalizeStrategyResult(
    [strategyName]Signal, 
    '[STRATEGY_NAME]', 
    mode
  );
  
  // ... update bestSignal priority logic ...
  
  // SAFE_MODE priority
  const priority = ['TREND_4H', 'SWING', '[STRATEGY_NAME]', 'SCALP_1H', 'MICRO_SCALP'];
  
  // AGGRESSIVE_MODE priority
  const priority = ['TREND_4H', '[STRATEGY_NAME]', 'SCALP_1H', 'MICRO_SCALP', 'SWING'];
}
```

**Checklist:**
- [ ] Added to strategies object
- [ ] Added to evaluation list
- [ ] Added to SAFE_MODE priority order
- [ ] Added to AGGRESSIVE_MODE priority order
- [ ] Result normalized via `normalizeStrategyResult()`

---

### Step 4: Update Frontend Display

**File:** `public/index.html`

#### 4.1: Add Strategy Button

**Location:** Strategy buttons section (around line 2900)

```javascript
// Add to strategyOptions array
const strategyOptions = ['4h', 'Swing', 'Scalp', 'MicroScalp', '[YourStrategy]'];

// Add to strategyMap
const strategyMap = {
  '4h': 'TREND_4H',
  'Swing': 'SWING',
  'Scalp': 'SCALP_1H',
  'MicroScalp': 'MICRO_SCALP',
  '[YourStrategy]': '[STRATEGY_NAME]'  // ADD THIS
};
```

#### 4.2: Add Template Evaluation (if needed)

**Location:** `evaluateTemplateSignal()` function (around line 1414)

```javascript
// If strategy needs frontend evaluation (usually not needed - use API)
if (templateKey === '[YourStrategy]') {
  return evaluate[StrategyName]Frontend(symbol, data);
}
```

#### 4.3: Update Display Logic

**Location:** `createDetailsRow()` and related display functions

Ensure the strategy name is handled in:
- Signal badge display
- Strategy button highlighting
- Details section
- JSON export

**Checklist:**
- [ ] Strategy button added
- [ ] Strategy name mapping added
- [ ] Display logic handles new strategy
- [ ] Details section shows strategy-specific info

---

### Step 5: Update JSON Export

**File:** `public/index.html`  
**Function:** `buildRichSymbolFromScanResults()` (around line 4023)

The JSON export should automatically include your strategy if:
- It's in `evaluateAllStrategies()` return object
- Frontend uses `/api/analyze-full` endpoint

**Verification:**
- [ ] Strategy appears in `strategies` object in JSON
- [ ] All fields populated correctly
- [ ] Structure matches canonical format

---

### Step 6: Update API Endpoints (if needed)

**Files:** `api/analyze.js`, `api/analyze-full.js`

**Usually not needed** - API endpoints automatically include strategies from `evaluateAllStrategies()`.

**Check if needed:**
- [ ] Strategy appears in `/api/analyze-full` response
- [ ] Strategy appears in `/api/analyze` response (if using `setupType`)

---

### Step 7: Documentation

**Files to Update:**

1. **`docs/STRATEGY_IMPLEMENTATION_GUIDE.md`**
   - Add new strategy section
   - Document gatekeepers, entry logic, SL/TP
   - Add to strategy summary table

2. **`docs/STRATEGY_DOCUMENTATION_REVIEW.md`**
   - Note new strategy added
   - Update strategy count

**Checklist:**
- [ ] Strategy documented in implementation guide
- [ ] Gatekeepers documented
- [ ] Entry requirements documented
- [ ] SL/TP calculation documented
- [ ] Confidence scoring documented
- [ ] Examples provided

---

## Testing Checklist

### Unit Tests
- [ ] Strategy function returns null when gatekeepers fail
- [ ] Strategy function returns signal when conditions met
- [ ] Entry zone calculated correctly
- [ ] Stop loss calculated correctly
- [ ] Targets calculated correctly
- [ ] Confidence score reasonable (0-100)

### Integration Tests
- [ ] Strategy appears in `evaluateAllStrategies()` results
- [ ] Strategy appears in correct priority order
- [ ] Strategy works in STANDARD mode
- [ ] Strategy works in AGGRESSIVE mode (if applicable)
- [ ] Strategy appears in frontend display
- [ ] Strategy appears in JSON exports

### Regression Tests
- [ ] Existing strategies still work
- [ ] No breaking changes to API responses
- [ ] Frontend displays all strategies correctly
- [ ] JSON exports include all strategies

---

## Common Patterns

### Pattern 1: HTF-Based Strategy (like SWING)

```javascript
// Requires: 3D, 1D, 4H timeframes
// Gatekeepers: All HTF trends must NOT be FLAT
// Entry: Based on HTF structure
// SL: HTF swing levels
// Targets: Higher R:R (3R, 4R, 5R)
```

### Pattern 2: Primary TF Strategy (like TREND_4H)

```javascript
// Requires: 4H, 1H timeframes
// Gatekeepers: Primary TF must NOT be FLAT
// Entry: Based on primary TF EMA
// SL: Primary TF structure
// Targets: Medium R:R (1R, 2R)
```

### Pattern 3: LTF Strategy (like SCALP_1H)

```javascript
// Requires: 1H, 15m, 5m timeframes
// Gatekeepers: 1H must NOT be FLAT (4H can be FLAT)
// Entry: Based on 1H EMA with LTF confirmation
// SL: LTF structure (15m/5m)
// Targets: Lower R:R (1.5R, 3R)
```

### Pattern 4: Mean-Reversion Strategy (like MICRO_SCALP)

```javascript
// Requires: 1H, 15m, 5m timeframes
// Gatekeepers: 1H trending, tight LTF confluence
// Entry: Average of LTF EMAs
// SL: Tight LTF structure
// Targets: Very tight R:R (1R, 1.5R)
```

---

## Strategy Naming Conventions

### Function Names
- `evaluate[StrategyName]()` - PascalCase
- Example: `evaluateSwingSetup()`, `evaluateMicroScalp()`

### Strategy Constants
- `[STRATEGY_NAME]` - UPPER_SNAKE_CASE
- Example: `SWING`, `TREND_4H`, `SCALP_1H`, `MICRO_SCALP`

### Setup Type Strings
- `'[StrategyName]'` - PascalCase string
- Example: `'Swing'`, `'4h'`, `'Scalp'`, `'MicroScalp'`

### Frontend Display Names
- `'[DISPLAY NAME]'` - Human-readable
- Example: `'SWING'`, `'4 HOUR'`, `'SCALP'`, `'MICRO-SCALP'`

---

## Integration Points Summary

| Component | File | Function | Action |
|-----------|------|----------|--------|
| **Evaluation** | `services/strategy.js` | `evaluate[StrategyName]()` | Create function |
| **Main Entry** | `services/strategy.js` | `evaluateStrategy()` | Add to priority |
| **All Strategies** | `services/strategy.js` | `evaluateAllStrategies()` | Add to evaluation |
| **Frontend Buttons** | `public/index.html` | Strategy buttons | Add button |
| **Frontend Display** | `public/index.html` | `createDetailsRow()` | Handle display |
| **JSON Export** | `public/index.html` | `buildRichSymbolFromScanResults()` | Auto-included |
| **Documentation** | `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` | - | Add section |

---

## Example: Adding a "Daily Swing" Strategy

### Step 1: Define Strategy

- **Timeframes:** 1D → 4H → 1H
- **Gatekeepers:** 1D NOT FLAT, 4H NOT FLAT
- **Entry:** 1D reclaim/rejection
- **SL:** 1D swing levels
- **Targets:** 2R, 3R, 4R

### Step 2: Create Function

```javascript
function evaluateDailySwing(multiTimeframeData, currentPrice, mode = 'STANDARD') {
  const tf1d = multiTimeframeData['1d'];
  const tf4h = multiTimeframeData['4h'];
  const tf1h = multiTimeframeData['1h'];
  
  // Gatekeepers
  if (!tf1d || !tf4h || !tf1h) return null;
  if (tf1d.indicators?.analysis?.trend === 'FLAT') return null;
  if (tf4h.indicators?.analysis?.trend === 'FLAT') return null;
  
  // Entry logic...
  // SL/TP calculation...
  // Confidence scoring...
  
  return { /* canonical signal */ };
}
```

### Step 3: Integrate

Add to `evaluateStrategy()` priority order and `evaluateAllStrategies()`.

### Step 4: Frontend

Add button, update display logic.

### Step 5: Document

Add to `STRATEGY_IMPLEMENTATION_GUIDE.md`.

---

## Troubleshooting

### Strategy not appearing in results
- Check gatekeepers aren't too strict
- Verify all required timeframes available
- Check function returns valid signal structure

### Strategy appearing but invalid
- Verify entry requirements logic
- Check confidence calculation
- Ensure all required fields present

### Frontend not displaying
- Check strategy name mapping
- Verify button added to UI
- Check display logic handles strategy

### JSON export missing strategy
- Verify in `evaluateAllStrategies()` return
- Check API endpoint includes strategy
- Verify frontend uses correct API

---

## Best Practices

1. **Start Simple:** Begin with basic gatekeepers and entry logic
2. **Test Incrementally:** Test each component before moving to next
3. **Use Existing Patterns:** Follow SWING or TREND_4H as templates
4. **Document as You Go:** Update docs immediately, not later
5. **Verify Data Paths:** Ensure indicator access paths are correct
6. **Test Edge Cases:** Test with insufficient data, FLAT trends, etc.
7. **Maintain Consistency:** Follow existing code patterns and naming

---

## Related Documentation

- `STRATEGY_IMPLEMENTATION_GUIDE.md` - Current strategies reference
- `INDICATOR_ARCHITECTURE.md` - How indicators work
- `INDICATOR_INTEGRATION_CHECKLIST.md` - Adding indicators
- `STRATEGY_MODES.md` - STANDARD vs AGGRESSIVE

---

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0

