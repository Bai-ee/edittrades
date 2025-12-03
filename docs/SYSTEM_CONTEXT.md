# System Context - Complete Reference for AI Strategy Updates

**Purpose:** This document provides complete system context for generating strategy updates that are compatible with the current implementation.

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0

---

## Quick Start for AI Assistants

When generating strategy updates, you MUST:
1. Follow the existing strategy structure and naming conventions
2. Use the hierarchical confidence system
3. Respect STANDARD vs AGGRESSIVE mode differences
4. Include all required fields in signal objects
5. Use correct data access paths

---

## Current System State

### Strategies (5 Total)

1. **SWING** - `evaluateSwingSetup()` - 3D → 1D → 4H structure trades
2. **TREND_4H** - `evaluateStrategy(..., '4h')` - 4H trend following
3. **TREND_RIDER** - `evaluateTrendRider()` - 4H/1H continuation (NEW)
4. **SCALP_1H** - `evaluateStrategy(..., 'Scalp')` - 1H scalps
5. **MICRO_SCALP** - `evaluateMicroScalp()` - LTF mean reversion

### Priority Order

**STANDARD Mode:**
1. TREND_4H
2. TREND_RIDER
3. SWING
4. SCALP_1H
5. MICRO_SCALP

**AGGRESSIVE Mode:**
1. TREND_RIDER
2. TREND_4H
3. SCALP_1H
4. MICRO_SCALP
5. SWING

### Timeframes Supported

- **Direct from Kraken:** 1m, 3m, 5m, 15m, 1h, 4h, 1d
- **Aggregated:** 3d (from 1d), 1w (from 1d), 1M (from 1d)

---

## Data Access Paths (CRITICAL)

### Indicator Access

```javascript
// CORRECT paths (use these):
const tf4h = analysis['4h'];
const trend = tf4h.indicators.analysis.trend;              // NOT indicators.trend
const pullbackState = tf4h.indicators.analysis.pullbackState;  // NOT indicators.pullback
const distanceFrom21EMA = tf4h.indicators.analysis.distanceFrom21EMA;
const ema21 = tf4h.indicators.ema.ema21;
const ema200 = tf4h.indicators.ema.ema200;
const stochRSI = tf4h.indicators.stochRSI;  // { k, d, condition, history }
const currentPrice = tf4h.indicators.price.current;
const swingHigh = tf4h.structure.swingHigh;
const swingLow = tf4h.structure.swingLow;
```

### Common Mistakes to Avoid

❌ **WRONG:**
```javascript
analysis[tf].indicators.trend
analysis[tf].indicators.pullback
analysis[tf].pullbackState
```

✅ **CORRECT:**
```javascript
analysis[tf].indicators.analysis.trend
analysis[tf].indicators.analysis.pullbackState
analysis[tf].indicators.analysis.distanceFrom21EMA
```

---

## Strategy Signal Structure (REQUIRED)

Every strategy MUST return this structure:

```javascript
{
  valid: boolean,                    // true if trade is valid
  direction: 'long' | 'short' | 'NO_TRADE',
  setupType: string,                 // Strategy name (e.g., 'TrendRider')
  selectedStrategy: string,          // Strategy key (e.g., 'TREND_RIDER')
  strategiesChecked: Array<string>,  // All strategies evaluated
  confidence: number,                // 0-100 (MUST use hierarchical system)
  reason: string,                    // Human-readable reason
  reason_summary: string,             // Optional: detailed summary
  penaltiesApplied: Array<Object>,    // From confidence calculation
  capsApplied: Array<string>,        // From confidence calculation
  explanation: string,                // Confidence explanation
  entryZone: {
    min: number,
    max: number
  },
  stopLoss: number,
  invalidationLevel: number,
  targets: Array<number>,             // [tp1, tp2, ...]
  riskReward: {
    tp1RR: number,
    tp2RR: number
  },
  riskAmount: number,                 // Optional
  invalidation: {
    level: number,
    description: string
  },
  confluence: {
    trendAlignment: string,
    stochMomentum: string,
    pullbackState: string,
    liquidityZones: string,
    htfConfirmation: string
  },
  conditionsRequired: Array<string>, // List of required conditions
  currentPrice: number,
  timestamp: string,                 // ISO format
  htfBias: {                         // From computeHTFBias()
    direction: 'long' | 'short' | 'neutral',
    confidence: number,               // 0-100
    source: string
  }
}
```

---

## Confidence Calculation (MANDATORY)

**ALWAYS use hierarchical confidence system:**

```javascript
// Use this function:
const confidenceResult = calculateConfidenceWithHierarchy(
  multiTimeframeData,
  direction,
  mode  // 'STANDARD' or 'AGGRESSIVE'
);

// Returns:
{
  confidence: number,        // 0-100
  penaltiesApplied: Array,
  capsApplied: Array,
  explanation: string
}
```

### Hierarchical Weights

- **Macro Layer (40%):** 1M, 1w, 3d, 1d timeframes
- **Primary Layer (35%):** 4H, 1H timeframes
- **Execution Layer (25%):** 15m, 5m, 3m, 1m timeframes

### Hard Caps

| Condition | STANDARD Max | AGGRESSIVE Max |
|-----------|--------------|----------------|
| ANY macro contradiction | 75% | 80% |
| 4H contradiction | 65% | 70% |
| 1D + 4H contradiction | 55% | 60% |
| 1D opposite + exhaustion | 45% | 50% |

**DO NOT** use the old `calculateConfidence()` function - it's deprecated.

---

## Mode Differences (STANDARD vs AGGRESSIVE)

### STANDARD Mode

- **4H FLAT = Hard Block** (all strategies NO_TRADE)
- **Min HTF Bias:** 60% confidence
- **Min Strategy Confidence:** 60% (SWING, TREND_4H, TREND_RIDER, SCALP_1H), 50% (MICRO_SCALP)
- **Stricter Requirements:** All gatekeepers must pass

### AGGRESSIVE Mode

- **4H FLAT = Soft Gate** (can use HTF bias if confidence ≥ 70%)
- **Min HTF Bias:** 40% confidence
- **Min Strategy Confidence:** 50% (all strategies)
- **Looser Requirements:** Some gatekeepers can be bypassed
- **Forcing Logic:** Can force valid trades when HTF bias + lower TFs align

---

## Strategy Evaluation Flow

### In `evaluateAllStrategies()`

```javascript
export function evaluateAllStrategies(symbol, multiTimeframeData, mode = 'STANDARD') {
  // 1. Initialize strategies object
  const strategies = {
    SWING: null,
    TREND_4H: null,
    TREND_RIDER: null,
    SCALP_1H: null,
    MICRO_SCALP: null
  };
  
  // 2. Check 4H FLAT gate (STANDARD mode)
  if (mode === 'STANDARD' && is4HFlat) {
    // Return all NO_TRADE
    return { strategies: { all NO_TRADE }, bestSignal: null };
  }
  
  // 3. Evaluate each strategy
  strategies.SWING = normalizeStrategyResult(evaluateSwingSetup(...), 'SWING', mode);
  strategies.TREND_4H = normalizeStrategyResult(evaluateStrategy(..., '4h'), 'TREND_4H', mode);
  strategies.TREND_RIDER = normalizeStrategyResult({ signal: evaluateTrendRider(...) }, 'TREND_RIDER', mode);
  strategies.SCALP_1H = normalizeStrategyResult(evaluateStrategy(..., 'Scalp'), 'SCALP_1H', mode);
  strategies.MICRO_SCALP = normalizeStrategyResult(evaluateMicroScalp(...), 'MICRO_SCALP', mode);
  
  // 4. AGGRESSIVE forcing logic (if 4H FLAT)
  if (mode === 'AGGRESSIVE' && is4HFlat) {
    // Force valid trades based on HTF bias + lower TFs
  }
  
  // 5. Select best signal by priority
  // 6. Return { strategies, bestSignal }
}
```

### Strategy Functions Must:

1. **Check Gatekeepers First** - Return `null` or `invalidNoTrade()` if gatekeepers fail
2. **Evaluate Entry Logic** - Check all entry requirements
3. **Calculate Confidence** - Use `calculateConfidenceWithHierarchy()`
4. **Calculate SL/TP** - Use `calculateSLTP()` helper
5. **Build Signal Object** - Include ALL required fields
6. **Return Signal** - Return complete signal object or `null`

---

## Helper Functions Available

### Entry Zone Calculation

```javascript
const entryZone = calculateEntryZone(ema21, direction);
// Returns: { min: number, max: number }
// Uses 0.4% buffer by default
```

### Stop Loss / Take Profit Calculation

```javascript
const sltp = calculateSLTP(
  entryPrice,           // number
  direction,            // 'long' | 'short'
  allStructures,       // { '1h': { swingHigh, swingLow }, ... }
  setupType,           // 'TrendRider', 'Scalp', '4h', etc.
  rrTargets            // [2.0, 3.5] for example
);

// Returns:
{
  stopLoss: number,
  invalidationLevel: number,
  targets: [number, number],
  rrTargets: [number, number],
  riskAmount: number
}
```

### HTF Bias Calculation

```javascript
const htfBias = computeHTFBias(multiTimeframeData);

// Returns:
{
  direction: 'long' | 'short' | 'neutral',
  confidence: number,  // 0-100
  source: string       // e.g., '1D + 3D alignment'
}
```

### Trend Normalization

```javascript
const trend = normalizeTrend(trendRaw);
// Converts: 'UPTREND', 'uptrend', 'UP' → 'uptrend'
// Converts: 'DOWNTREND', 'downtrend', 'DOWN' → 'downtrend'
// Everything else → 'flat'
```

### No Trade Helper

```javascript
const noTrade = invalidNoTrade(reason);
// Returns: { valid: false, direction: 'NO_TRADE', confidence: 0, reason, ... }
```

---

## Strategy Integration Points

### 1. Add to `evaluateAllStrategies()`

```javascript
// In services/strategy.js, evaluateAllStrategies() function:

// Initialize
const strategies = {
  SWING: null,
  TREND_4H: null,
  TREND_RIDER: null,
  YOUR_NEW_STRATEGY: null,  // ADD HERE
  SCALP_1H: null,
  MICRO_SCALP: null
};

// Evaluate
strategies.YOUR_NEW_STRATEGY = normalizeStrategyResult(
  { signal: evaluateYourNewStrategy(multiTimeframeData, currentPrice, mode) },
  'YOUR_NEW_STRATEGY',
  mode
);

// Add to priority arrays
// STANDARD: const priority = ['TREND_4H', 'TREND_RIDER', 'SWING', 'SCALP_1H', 'MICRO_SCALP', 'YOUR_NEW_STRATEGY'];
// AGGRESSIVE: const priority = ['TREND_RIDER', 'TREND_4H', 'SCALP_1H', 'MICRO_SCALP', 'SWING', 'YOUR_NEW_STRATEGY'];
```

### 2. Export Function

```javascript
// At bottom of services/strategy.js:
export default {
  evaluateStrategy,
  evaluateAllStrategies,
  evaluateTrendRider,
  evaluateYourNewStrategy,  // ADD HERE
  // ... other exports
};
```

### 3. Frontend Integration

**File:** `public/index.html`

```javascript
// Add to strategyOptions array
const strategyOptions = ['Swing', 'Trend4h', 'TrendRider', 'YourNewStrategy', 'Scalp', 'MicroScalp'];

// Add to strategyMap
const strategyMap = {
  'Swing': 'SWING',
  'Trend4h': 'TREND_4H',
  'TrendRider': 'TREND_RIDER',
  'YourNewStrategy': 'YOUR_NEW_STRATEGY',  // ADD HERE
  'Scalp': 'SCALP_1H',
  'MicroScalp': 'MICRO_SCALP'
};

// Add to tradeTemplates
const tradeTemplates = {
  // ... existing templates
  'YourNewStrategy': {
    label: 'Your Strategy Name',
    anchorTimeframes: ['4h', '1h'],
    confirmTimeframes: ['15m', '5m'],
    entryTimeframes: ['15m', '5m'],
    minConfidence: 0.65,
    maxLeverage: 25,
    rrTargets: [2.0, 3.5],
    maxHoldCandles: { '1h': 24 },
    displayName: 'YOUR NEW STRATEGY'
  }
};
```

---

## Common Patterns

### Gatekeeper Pattern

```javascript
// Check gatekeepers first
if (mode === 'STANDARD' && trend4h === 'flat') {
  return invalidNoTrade('4H trend is FLAT - no trade allowed per STANDARD mode rules');
}

if (!htfBias || htfBias.confidence < minBiasConfidence) {
  return invalidNoTrade(`HTF bias insufficient (${htfBias?.confidence || 0}% < ${minBiasConfidence}%)`);
}
```

### Entry Logic Pattern

```javascript
// Determine direction
let direction = null;
if (longCandidate) {
  direction = 'long';
} else if (shortCandidate) {
  direction = 'short';
}

if (!direction) {
  return null;  // No valid setup
}
```

### Confidence Pattern

```javascript
// ALWAYS use hierarchical system
const confidenceResult = calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode);
let confidence = confidenceResult.confidence || 0;

// Optional: Add alignment bonuses
if (macroAligned && primaryAligned) confidence += 5;
if (tightPullback) confidence += 3;
confidence = Math.min(90, confidence);  // Cap before hard caps
```

### SL/TP Pattern

```javascript
// Use helper function
const allStructures = {
  '1h': { swingHigh: swing1h.swingHigh, swingLow: swing1h.swingLow },
  '4h': { swingHigh: swing4h.swingHigh, swingLow: swing4h.swingLow },
  // ... other timeframes
};

const rrTargets = [2.0, 3.5];  // Strategy-specific
const sltp = calculateSLTP(entryMid, direction, allStructures, 'YourStrategy', rrTargets);
```

---

## File Locations

| Component | File | Key Functions |
|-----------|------|---------------|
| Strategy Evaluation | `services/strategy.js` | `evaluateAllStrategies()`, `evaluateStrategy()`, `evaluateTrendRider()`, etc. |
| Indicator Calculation | `services/indicators.js` | `calculateAllIndicators()`, `detectSwingPoints()` |
| Market Data | `services/marketData.js` | `getMultiTimeframeData()`, `getTickerPrice()`, `getDflowPredictionMarkets()` |
| API Endpoint | `api/analyze-full.js` | Main endpoint that assembles all data |
| Frontend | `public/index.html` | `createDetailsRow()`, `buildRichSymbolFromScanResults()` |

---

## JSON Output Structure

The system returns this structure from `/api/analyze-full`:

```javascript
{
  symbol: string,
  mode: 'SAFE' | 'AGGRESSIVE',
  currentPrice: number,
  marketData: {
    spread: number,
    spreadPercent: number,
    bid: number,
    ask: number,
    bidAskImbalance: number,
    volumeQuality: 'HIGH' | 'MEDIUM' | 'LOW' | 'N/A',
    tradeCount24h: number,
    orderBook: { bidLiquidity, askLiquidity, imbalance },
    recentTrades: { overallFlow, buyPressure, sellPressure, volumeImbalance }
  },
  dflowData: {
    symbol: string,
    events: Array,
    markets: Array
  },
  htfBias: {
    direction: 'long' | 'short' | 'neutral',
    confidence: number,
    source: string
  },
  timeframes: {
    '1m': { trend, ema21, ema200, stoch, pullback, structure, indicators },
    '3m': { ... },
    // ... all timeframes
  },
  strategies: {
    SWING: { valid, direction, confidence, entryZone, stopLoss, targets, ... },
    TREND_4H: { ... },
    TREND_RIDER: { ... },
    SCALP_1H: { ... },
    MICRO_SCALP: { ... }
  },
  bestSignal: 'TREND_4H' | null,
  schemaVersion: '1.0.0',
  jsonVersion: '0.05',
  generatedAt: string  // ISO timestamp
}
```

---

## Testing Checklist

When adding/modifying strategies:

- [ ] Strategy function returns correct signal structure
- [ ] All required fields present when `valid: true`
- [ ] Confidence uses hierarchical system (0-100)
- [ ] Gatekeepers work correctly (STANDARD vs AGGRESSIVE)
- [ ] Entry zones calculated correctly
- [ ] SL/TP calculated correctly
- [ ] Strategy appears in `evaluateAllStrategies()` results
- [ ] Strategy included in priority arrays
- [ ] Frontend displays strategy correctly
- [ ] JSON export includes strategy
- [ ] No breaking changes to existing strategies

---

## Key Principles

1. **Always use hierarchical confidence** - Never use old `calculateConfidence()`
2. **Respect mode differences** - STANDARD is stricter than AGGRESSIVE
3. **Use correct data paths** - `indicators.analysis.trend` not `indicators.trend`
4. **Include all required fields** - Signal structure must be complete
5. **Normalize strategy results** - Use `normalizeStrategyResult()` helper
6. **Test with both modes** - Verify STANDARD and AGGRESSIVE behavior
7. **Update priority arrays** - Add to both STANDARD and AGGRESSIVE priorities
8. **Export functions** - Add to default export object
9. **Frontend integration** - Update `strategyOptions`, `strategyMap`, `tradeTemplates`
10. **Documentation** - Update relevant docs after implementation

---

## Related Documentation

For detailed information, see:

- **`SYSTEM_WORKFLOW.md`** - Complete workflow and element impact
- **`STRATEGY_IMPLEMENTATION_GUIDE.md`** - Detailed strategy specifications
- **`STRATEGY_SYSTEM_AUDIT.md`** - System architecture and audit
- **`STRATEGY_MODES.md`** - Mode differences in detail
- **`INDICATOR_ARCHITECTURE.md`** - Indicator system overview
- **`ADDING_STRATEGIES.md`** - Step-by-step integration guide

---

## Example: Adding a New Strategy

```javascript
/**
 * Evaluate Your New Strategy
 * @param {Object} multiTimeframeData - All timeframe data
 * @param {number} currentPrice - Current market price
 * @param {string} mode - STANDARD or AGGRESSIVE
 * @returns {Object|null} Strategy signal or null
 */
export function evaluateYourNewStrategy(multiTimeframeData, currentPrice, mode = 'STANDARD') {
  // 1. Extract timeframes
  const tf4h = multiTimeframeData['4h'];
  const tf1h = multiTimeframeData['1h'];
  // ... other timeframes
  
  // 2. Guard: Check required data
  if (!tf4h || !tf1h) return null;
  
  // 3. Extract indicators (USE CORRECT PATHS)
  const trend4h = tf4h.indicators?.analysis?.trend;
  const ema21_4h = tf4h.indicators?.ema?.ema21;
  // ... other indicators
  
  // 4. Check gatekeepers
  if (mode === 'STANDARD' && trend4h === 'FLAT') {
    return null;  // Or use invalidNoTrade()
  }
  
  // 5. Calculate HTF bias
  const htfBias = computeHTFBias(multiTimeframeData);
  if (htfBias.confidence < (mode === 'AGGRESSIVE' ? 40 : 60)) {
    return null;
  }
  
  // 6. Evaluate entry logic
  let direction = null;
  // ... your entry logic
  
  if (!direction) return null;
  
  // 7. Calculate entry zone
  const entryAnchor = ema21_4h;
  const baseZone = calculateEntryZone(entryAnchor, direction);
  const entryMid = (baseZone.min + baseZone.max) / 2;
  
  // 8. Calculate SL/TP
  const allStructures = {
    '4h': tf4h.structure || {},
    '1h': tf1h.structure || {}
  };
  const rrTargets = [2.0, 3.5];
  const sltp = calculateSLTP(entryMid, direction, allStructures, 'YourStrategy', rrTargets);
  
  // 9. Calculate confidence (MANDATORY - use hierarchical)
  const confidenceResult = calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode);
  let confidence = confidenceResult.confidence || 0;
  
  // 10. Build signal object (ALL REQUIRED FIELDS)
  const signal = {
    valid: true,
    direction,
    setupType: 'YourStrategy',
    selectedStrategy: 'YOUR_NEW_STRATEGY',
    strategiesChecked: ['YOUR_NEW_STRATEGY'],
    confidence: Math.round(confidence),
    reason: 'Your strategy reason',
    reason_summary: confidenceResult.explanation ? `Your reason [${confidenceResult.explanation}]` : 'Your reason',
    penaltiesApplied: confidenceResult.penaltiesApplied || [],
    capsApplied: confidenceResult.capsApplied || [],
    explanation: confidenceResult.explanation || '',
    entryZone: {
      min: parseFloat(baseZone.min.toFixed(2)),
      max: parseFloat(baseZone.max.toFixed(2))
    },
    stopLoss: parseFloat(sltp.stopLoss.toFixed(2)),
    invalidationLevel: parseFloat(sltp.invalidationLevel.toFixed(2)),
    targets: (sltp.targets || []).map(t => parseFloat(t.toFixed(2))),
    riskReward: {
      tp1RR: sltp.rrTargets?.[0] ?? rrTargets[0],
      tp2RR: sltp.rrTargets?.[1] ?? rrTargets[1]
    },
    riskAmount: parseFloat((sltp.riskAmount ?? 0).toFixed(2)),
    invalidation: {
      level: parseFloat(sltp.invalidationLevel.toFixed(2)),
      description: 'Your invalidation description'
    },
    confluence: {
      trendAlignment: `4H: ${trend4h}, 1H: ${trend1h}`,
      stochMomentum: `4H stoch: ${stoch4h?.condition || 'N/A'}`,
      pullbackState: `4H: ${pullback4h?.state || 'N/A'}`,
      liquidityZones: 'Using 4H/1H structure',
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },
    conditionsRequired: [
      '✓ Your condition 1',
      '✓ Your condition 2',
      // ... more conditions
    ],
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString(),
    htfBias
  };
  
  return signal;
}
```

---

## Critical Do's and Don'ts

### ✅ DO:

- Use `calculateConfidenceWithHierarchy()` for confidence
- Use correct data paths (`indicators.analysis.trend`)
- Include ALL required fields in signal object
- Check gatekeepers first
- Use helper functions (`calculateEntryZone`, `calculateSLTP`, `computeHTFBias`)
- Normalize strategy results with `normalizeStrategyResult()`
- Test with both STANDARD and AGGRESSIVE modes
- Update priority arrays in `evaluateAllStrategies()`
- Export new strategy functions

### ❌ DON'T:

- Use old `calculateConfidence()` function
- Use incorrect data paths (`indicators.trend` instead of `indicators.analysis.trend`)
- Skip required fields in signal object
- Hardcode confidence values
- Bypass gatekeepers without proper mode checks
- Return incomplete signal objects
- Forget to add to `evaluateAllStrategies()`
- Forget to update priority arrays
- Forget frontend integration

---

**This document provides everything needed to generate compatible strategy updates. Reference it when creating new strategies or modifying existing ones.**

