# Troubleshooting Guide

**Last Updated:** 2025-01-XX  
**Status:** Production Ready  
**Milestone Tag:** `v1.0-data-parity`

---

## Quick Diagnostic Commands

### Check Module Presence

```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, ms: (.value.marketStructure != null), vp: (.value.volumeProfile != null), vol: (.value.volatility != null), lz: (.value.liquidityZones != null), fvg: (.value.fairValueGaps != null), div: (.value.divergences != null)})'
```

**Expected:** All values should be `true`

### Check for Null Values

```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, msNull: (.value.marketStructure == null), vpNull: (.value.volumeProfile == null), volNull: (.value.volatility == null)})'
```

**Expected:** All values should be `false`

### Check Volatility State

```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, volState: .value.volatility.state, volStateNull: (.value.volatility.state == null)})'
```

**Expected:** All `volState` should be one of: `"low"`, `"normal"`, `"high"`, `"extreme"`  
**Expected:** All `volStateNull` should be `false`

### Check Timeframes Object

```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.timeframes | to_entries | map({tf: .key, ms: (.value.marketStructure != null), vp: (.value.volumeProfile != null)})'
```

**Expected:** All values should be `true`

---

## Common Issues & Solutions

### Issue 1: Module Returns Null

**Symptoms:**
- `marketStructure: null`
- `volumeProfile: null`
- `volatility: null`

**Root Causes:**
1. Calculation function returns `null` instead of structured object
2. Validation layer not enforcing fallbacks
3. Export layer not applying fallbacks

**Diagnosis:**
```bash
# Check if calculation is returning null
# Look at console logs for module calculation errors
```

**Solution:**

**Step 1:** Check module function
```javascript
// ❌ WRONG
if (!candles || candles.length < 10) {
  return null;
}

// ✅ CORRECT
if (!candles || candles.length < 10) {
  return getDefaultStructure();  // Never null
}
```

**Step 2:** Check validation layer
```javascript
// In lib/dataValidation.js - validateTimeframeAnalysis()
if (!validated.marketStructure) {
  validated.marketStructure = {
    currentStructure: 'unknown',
    lastSwings: [],
    lastBos: { type: 'none', direction: 'none', ... },
    lastChoch: { type: 'none', direction: 'none', ... }
  };
}
```

**Step 3:** Check export layer
```javascript
// In services/strategy.js - buildTimeframeSummary()
marketStructure: data.marketStructure || {
  currentStructure: 'unknown',
  // ... default structure
}
```

---

### Issue 2: Volatility State is Null

**Symptoms:**
- `volatility.state: null`
- ATR value present but state missing

**Root Causes:**
1. `calculateATR()` not classifying state
2. `validateVolatility()` not ensuring state exists
3. API endpoint not setting default state

**Diagnosis:**
```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["4h"].volatility'
```

**Solution:**

**Step 1:** Check ATR calculation
```javascript
// In lib/advancedIndicators.js - calculateATR()
let volatilityState = 'NORMAL';
if (atrPct < 0.5) {
  volatilityState = 'LOW';
} else if (atrPct > 5.0) {
  volatilityState = 'EXTREME';
} else if (atrPct > 2.0) {
  volatilityState = 'HIGH';
}
volatilityState = volatilityState.toLowerCase();  // Ensure lowercase
```

**Step 2:** Check validation
```javascript
// In lib/dataValidation.js - validateVolatility()
if (!fixed.state || !validStates.includes(fixed.state.toLowerCase())) {
  // Auto-classify from ATR%
  if (fixed.atrPctOfPrice !== null) {
    fixed.state = classifyVolatility(fixed.atrPctOfPrice);
  } else {
    fixed.state = 'normal';  // Default
  }
}
```

**Step 3:** Check API endpoint
```javascript
// In api/analyze-full.js
volatility: volatility || {
  atr: null,
  atrPctOfPrice: null,
  state: 'normal'  // Always set default state
}
```

---

### Issue 3: Volume Profile Empty

**Symptoms:**
- `volumeProfile: { highVolumeNodes: [], lowVolumeNodes: [], valueAreaHigh: null, valueAreaLow: null }`
- No HVN/LVN detected even with sufficient candles

**Root Causes:**
1. Bins > candleCount (causes empty aggregation)
2. No volume data in candles
3. Invalid price range

**Diagnosis:**
```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["1m"] | {candleCount, vpHVN: (.volumeProfile.highVolumeNodes | length), hasVolume: (.lastCandle.volume != null)}'
```

**Solution:**

**Step 1:** Fix binning logic
```javascript
// In lib/advancedChartAnalysis.js - calculateVolumeProfile()
// Ensure bins <= candleCount
const numBins = Math.min(24, Math.max(3, Math.floor(candles.length / 3)), candles.length);
```

**Step 2:** Check volume data
```javascript
const hasVolume = candles.some(c => c.volume !== undefined && c.volume !== null && c.volume > 0);
if (!hasVolume) {
  return defaultProfile;  // Return empty structure, not null
}
```

**Step 3:** Validate price range
```javascript
if (priceRange <= 0 || !isFinite(binSize)) {
  return defaultProfile;
}
```

---

### Issue 4: Divergences Always Empty

**Symptoms:**
- `divergences: []` even when RSI/StochRSI data exists
- No divergences detected across all timeframes

**Root Causes:**
1. Pivot detection too strict
2. Divergence window too small
3. Insufficient separation threshold

**Diagnosis:**
```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["4h"] | {hasRSI: (.indicators.rsi != null), rsiHistory: (.indicators.rsi.history | length), divCount: (.divergences | length), candleCount: .candleCount}'
```

**Solution:**

**Step 1:** Reduce pivot depth
```javascript
// In lib/advancedChartAnalysis.js - calculateDivergences()
// Use shallow pivots (1 candle on each side)
const pivotDepth = Math.max(1, Math.min(2, Math.floor(closes.length / 5)));

// Fallback to 0-depth if needed
if (pricePivots.length < 2 && closes.length >= 3) {
  // Try even shallower detection
  for (let i = 1; i < closes.length - 1; i++) {
    // ... shallow pivot detection
  }
}
```

**Step 2:** Reduce minimum requirements
```javascript
// Reduced from 20 to 5 candles
if (!candles || candles.length < 5) {
  return [];
}

// Reduced from 10 to 5 data points
if (minLength < 5) {
  return [];
}
```

**Step 3:** Check RSI/StochRSI history alignment
```javascript
// Ensure history arrays are aligned with price
const rsi1 = rsiHistory[pivot1.index];
const rsi2 = rsiHistory[pivot2.index];

if (rsi1 !== undefined && rsi2 !== undefined) {
  // ... divergence detection
}
```

---

### Issue 5: Liquidity Zones Missing

**Symptoms:**
- `liquidityZones: []` on timeframes that should have zones
- Equal highs/lows not detected

**Root Causes:**
1. Tolerance too strict (0.5% too tight for lower timeframes)
2. Insufficient swing points
3. Minimum candle requirement too high

**Diagnosis:**
```bash
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis["1m"] | {candleCount, lzCount: (.liquidityZones | length)}'
```

**Solution:**

**Step 1:** Use dynamic tolerance
```javascript
// In lib/advancedChartAnalysis.js - calculateLiquidityZones()
const defaultTolerance = candles.length < 20 ? 0.2 : 0.5;  // % price difference
```

**Step 2:** Reduce minimum candles
```javascript
// Reduced from 10 to 5
if (!candles || candles.length < 5) {
  return [];
}
```

**Step 3:** Reduce pivot depth
```javascript
// Allow shallow pivots
const minLookback = Math.min(1, Math.floor(recentCandles.length / 4));
for (let i = minLookback; i < recentCandles.length - minLookback; i++) {
  // ... swing detection
}
```

---

### Issue 6: BOS/CHOCH Direction is "neutral" Instead of "none"

**Symptoms:**
- `marketStructure.lastBos.direction: "neutral"`
- Should be `"none"` when no event detected

**Root Causes:**
1. Default structure uses "neutral"
2. Validation not enforcing "none" for type="none"

**Solution:**

**Step 1:** Fix default structure
```javascript
// In lib/advancedChartAnalysis.js
const defaultBos = {
  type: 'none',
  direction: 'none',  // Not 'neutral'
  // ...
};
```

**Step 2:** Fix validation
```javascript
// In lib/dataValidation.js - validateMarketStructure()
if (fixed.lastBos.type === 'none') {
  fixed.lastBos.direction = 'none';  // Force direction to match type
}
```

**Step 3:** Fix calculation logic
```javascript
// In lib/advancedChartAnalysis.js
if (finalBos.type === 'none' && finalBos.direction !== 'none') {
  finalBos.direction = 'none';
}
```

---

### Issue 7: Volume is Null

**Symptoms:**
- `volume: null` in some timeframes
- Breaks signal generation

**Root Causes:**
1. `calculateVolumeAnalysis()` returns `null`
2. Validation not ensuring volume exists
3. Export layer not applying fallback

**Solution:**

**Step 1:** Fix volume calculation
```javascript
// In lib/volumeAnalysis.js
// Always return structured object
const defaultVolume = { current: 0, avg20: 0, trend: 'flat' };

if (!candles || candles.length < 1) {
  return defaultVolume;  // Never null
}

// Use last candle volume if available
const lastCandle = candles[candles.length - 1];
return {
  current: lastCandle?.volume || 0,
  avg20: calculateAvg20() || 0,
  trend: calculateTrend() || 'flat'
};
```

**Step 2:** Fix validation
```javascript
// In lib/dataValidation.js
if (!validated.volume || typeof validated.volume !== 'object') {
  validated.volume = { current: 0, avg20: 0, trend: 'flat' };
}
```

**Step 3:** Fix API endpoint
```javascript
// In api/analyze-full.js
volume: volume || { current: 0, avg20: 0, trend: 'flat' }
```

---

### Issue 8: Arrays are Null Instead of Empty

**Symptoms:**
- `liquidityZones: null`
- `fairValueGaps: null`
- `divergences: null`

**Root Causes:**
1. Module returns `null` instead of `[]`
2. Validation not enforcing arrays
3. Export layer not applying fallback

**Solution:**

**Step 1:** Fix module functions
```javascript
// Always return array, never null
if (!candles || candles.length < minCandles) {
  return [];  // Empty array, not null
}
```

**Step 2:** Fix validation
```javascript
// In lib/dataValidation.js
validated.liquidityZones = Array.isArray(validated.liquidityZones)
  ? validated.liquidityZones
  : [];  // Always array, never null
```

**Step 3:** Fix API endpoint
```javascript
// In api/analyze-full.js
liquidityZones: Array.isArray(advancedChart.liquidityZones)
  ? advancedChart.liquidityZones
  : []  // Always array, never null
```

---

## Debugging Workflow

### Step 1: Identify the Issue

```bash
# Run comprehensive check
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, issues: {
    msNull: (.value.marketStructure == null),
    vpNull: (.value.volumeProfile == null),
    volNull: (.value.volatility == null),
    volStateNull: (.value.volatility.state == null),
    lzNull: (.value.liquidityZones == null),
    fvgNull: (.value.fairValueGaps == null),
    divNull: (.value.divergences == null),
    volumeNull: (.value.volume == null)
  }})'
```

### Step 2: Check Calculation Layer

```bash
# Add console.log in module function
# Check server logs for calculation errors
```

### Step 3: Check Validation Layer

```bash
# Add console.log in validateTimeframeAnalysis
# Verify validation is running and applying fallbacks
```

### Step 4: Check Export Layer

```bash
# Check timeframes object
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.timeframes | to_entries | map({tf: .key, ms: (.value.marketStructure != null)})'
```

### Step 5: Fix and Test

1. Fix the issue at the appropriate layer
2. Restart server
3. Re-run diagnostic commands
4. Verify fix

---

## Prevention Checklist

Before deploying changes:

- [ ] All modules return structured objects/arrays (never null)
- [ ] Validation layer ensures all modules exist
- [ ] Export layer applies fallbacks
- [ ] Volatility state always classified
- [ ] Volume profile binning respects candle count
- [ ] Divergence detection works with shallow pivots
- [ ] Liquidity zones use dynamic tolerance
- [ ] BOS/CHOCH use "none" not "neutral"
- [ ] All timeframes tested for module presence
- [ ] Error handlers return defaults, not null

---

## Emergency Rollback

If data consistency breaks:

```bash
# Revert to stable milestone
git checkout v1.0-data-parity

# Or create branch from milestone
git checkout -b restore-consistency v1.0-data-parity
```

---

## Related Documentation

- [Data Pipeline Architecture](./DATA_PIPELINE_ARCHITECTURE.md)
- [Strategy Integration Guide](./STRATEGY_INTEGRATION_GUIDE.md)
- [Module Development Guide](./MODULE_DEVELOPMENT_GUIDE.md)
