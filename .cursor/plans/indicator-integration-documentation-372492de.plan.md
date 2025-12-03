<!-- 372492de-183e-429e-b3b9-dbf3b1093556 c9e21cb0-dd09-4b59-99fb-eac47db17c59 -->
# Add TREND_RIDER Strategy Implementation

## Overview

Add a new "Trend Rider" continuation strategy that enters earlier in strong trends (not just deep pullbacks) using 4H trend + 1H execution + 15m/5m confirmation. This strategy will be available in both STANDARD and AGGRESSIVE modes and positioned between TREND_4H and SCALP_1H in priority.

## Implementation Steps

### 1. Add evaluateTrendRider Function (services/strategy.js)

**Location:** After `evaluateMicroScalp` function (around line 1836) or after TREND_4H-related logic

**Action:** Add the complete `evaluateTrendRider` function as provided in the specification. The function:

- Takes `multiTimeframeData`, `currentPrice`, and `mode` parameters
- Extracts indicators from 4h, 1h, 15m, 5m timeframes
- Uses `computeHTFBias` to get higher timeframe bias
- Allows FLAT 4H in AGGRESSIVE mode if HTF bias is strong
- Validates pullback states and LTF confirmation
- Uses `calculateEntryZone`, `calculateSLTP`, and `calculateConfidenceWithHierarchy`
- Returns a canonical signal structure matching existing strategy patterns

**Key Features:**

- Requires HTF bias confidence >= 55 (STANDARD) or >= 55 (AGGRESSIVE)
- Allows shallow pullbacks (RETRACING/ENTRY_ZONE) on 1H
- Max overextension: 3.0% (STANDARD) or 4.5% (AGGRESSIVE)
- Uses 15m/5m Stoch RSI for confirmation
- RR targets: [2.0, 3.5]
- Entry zone anchored to 1H EMA21 with slight widening in AGGRESSIVE mode

### 5. Wire into evaluateStrategy (services/strategy.js)

**Location:** In `evaluateStrategy` function, after TREND_4H check (around line 1395-1615)

**Action:** Add TREND_RIDER as PRIORITY 3, after TREND_4H and before SCALP_1H:

```javascript
// PRIORITY 3: TREND_RIDER (after TREND_4H, before SCALP_1H)
if (setupType === 'TrendRider' || setupType === 'auto') {
  const trendRiderSignal = evaluateTrendRider(analysis, currentPrice, mode);
  if (trendRiderSignal && trendRiderSignal.valid) {
    return normalizeToCanonical(trendRiderSignal, analysis, mode);
  }
}
```

**Note:** Update priority comments to reflect: TREND_4H → TREND_RIDER → SWING → SCALP_1H → MICRO_SCALP

### 3. Wire into evaluateAllStrategies (services/strategy.js)

**Location:** In `evaluateAllStrategies` function (starting at line 2029)

**Actions:**

a) **Add TREND_RIDER to strategies object** (line 2032):

```javascript
const strategies = {
  SWING: null,
  TREND_4H: null,
  TREND_RIDER: null,  // NEW
  SCALP_1H: null,
  MICRO_SCALP: null
};
```

b) **Add TREND_RIDER to SAFE_MODE blocking** (line 2054):

```javascript
strategies.TREND_RIDER = createNoTradeStrategy('TREND_RIDER', flatReason);
```

c) **Evaluate TREND_RIDER** (after line 2075, before SCALP_1H):

```javascript
const trendRiderResult = evaluateStrategy(symbol, multiTimeframeData, 'TrendRider', mode);
```

d) **Normalize TREND_RIDER result** (after line 2082):

```javascript
strategies.TREND_RIDER = normalizeStrategyResult(trendRiderResult, 'TREND_RIDER', mode);
```

e) **Update priority arrays** (lines 2408-2409 and 2422-2423):

```javascript
// STANDARD priority
const priority = ['TREND_4H', 'TREND_RIDER', 'SWING', 'SCALP_1H', 'MICRO_SCALP'];

// AGGRESSIVE priority  
const priority = ['TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP', 'SWING'];
```

### 4. Export evaluateTrendRider (services/strategy.js)

**Location:** At the end of the file in the exports object (around line 2665)

**Action:** Add `evaluateTrendRider` to the exports:

```javascript
export {
  evaluateStrategy,
  evaluateAllStrategies,
  evaluateTrendSetup4h,
  evaluateScalp1h,
  evaluateMicroScalp,
  evaluateSwingSetup,
  evaluateTrendRider,  // NEW
  computeHTFBias
};
```

### 5. Frontend UI Updates (public/index.html) - Optional

**Location:** Strategy options and mapping (around lines 1118-1155)

**Actions:**

a) **Add to strategyOptions array** (line 1118):

```javascript
const strategyOptions = ['4h', 'Swing', 'TrendRider', 'Scalp', 'MicroScalp'];
```

b) **Add to strategyMap** (if exists, around line 1120):

```javascript
const strategyMap = {
  '4h': 'TREND_4H',
  'Swing': 'SWING',
  'TrendRider': 'TREND_RIDER',  // NEW
  'Scalp': 'SCALP_1H',
  'MicroScalp': 'MICRO_SCALP'
};
```

c) **Add strategy configuration** (in strategyConfig object, around line 1133):

```javascript
'TrendRider': {
  label: '4H/1H Trend Rider',
  anchorTimeframes: ['4h', '1h'],
  confirmTimeframes: ['15m', '5m'],
  entryTimeframes: ['15m', '5m'],
  minConfidence: 0.65,
  maxLeverage: 25,
  rrTargets: [2.0, 3.5],
  maxHoldCandles: { '1h': 24 },
  displayName: 'TREND RIDER'
}
```

## Verification Checklist

- [ ] `evaluateTrendRider` function added and follows existing pattern
- [ ] Function uses correct data paths (indicators.analysis.trend, etc.)
- [ ] Function calls helper functions correctly (calculateEntryZone, calculateSLTP, etc.)
- [ ] Wired into `evaluateStrategy` with correct priority
- [ ] Wired into `evaluateAllStrategies` with correct priority arrays
- [ ] Added to exports
- [ ] Frontend UI updated (if desired)
- [ ] No breaking changes to existing strategies
- [ ] Strategy appears in JSON output when valid
- [ ] Strategy respects STANDARD vs AGGRESSIVE mode differences

## Testing Notes

- STANDARD mode: Should only fire in strong, clean trends with shallow pullbacks
- AGGRESSIVE mode: Should tolerate FLAT 4H if HTF bias is strong (>=70%) and 4H stoch agrees
- Priority: TREND_RIDER should be selected after TREND_4H but before SCALP_1H when both are valid
- Entry zones should be slightly wider in AGGRESSIVE mode
- Confidence should use hierarchical system with alignment bonuses

## Files to Modify

1. `services/strategy.js` - Add function, wire into dispatchers, update priorities, export
2. `public/index.html` - Optional UI updates for strategy selector