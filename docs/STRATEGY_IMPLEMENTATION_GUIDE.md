# Strategy Implementation Guide

Complete reference for all trading strategies currently implemented in the system.

**Last Updated:** 2025-01-XX  
**Current Implementation:** `services/strategy.js`

---

## Table of Contents

1. [Strategy Overview](#strategy-overview)
2. [SWING Strategy](#swing-strategy)
3. [TREND_4H Strategy](#trend_4h-strategy)
4. [SCALP_1H Strategy](#scalp_1h-strategy)
5. [MICRO_SCALP Strategy](#micro_scalp-strategy)
6. [Strategy Evaluation Flow](#strategy-evaluation-flow)
7. [Confidence Scoring](#confidence-scoring)
8. [Data Structure Reference](#data-structure-reference)

---

## Strategy Overview

The system implements 5 distinct trading strategies, each with specific timeframes, gatekeepers, and risk/reward profiles.

### Strategy Summary

| Strategy | Timeframes | Gatekeepers | Targets | Stop Loss |
|----------|-----------|-------------|---------|-----------|
| **SWING** | 3D → 1D → 4H | 4H NOT FLAT, 3D NOT FLAT, 1D NOT FLAT | 3R, 4R, 5R | HTF (3D/1D) |
| **TREND_4H** | 4H → 1H → 15m/5m | 4H NOT FLAT (STANDARD) | 1R, 2R | 4H structure |
| **TREND_RIDER** | 4H → 1H → 15m/5m | HTF bias ≥ 55-65%, 4H/1H aligned | 2R, 3.5R | 1H/4H structure |
| **SCALP_1H** | 1H → 15m → 5m | 1H NOT FLAT | 1.5R, 3R | LTF (15m/5m) |
| **MICRO_SCALP** | 1H → 15m → 5m | 1H NOT FLAT, tight LTF confluence | 1R, 1.5R | 5m structure |

### Strategy Priority Order

**STANDARD Mode:**
1. TREND_4H (if 4H trending)
2. TREND_RIDER (if HTF bias + 4H/1H aligned)
3. SWING (if 3D/1D/4H structure)
4. SCALP_1H (if 1H trending)
5. MICRO_SCALP (if LTF confluence)

**AGGRESSIVE Mode:**
1. TREND_RIDER (if HTF bias + 4H/1H aligned)
2. TREND_4H (can use HTF bias when 4H FLAT)
3. SCALP_1H (looser requirements)
4. MICRO_SCALP (wider EMA bands)
5. SWING (unchanged)

---

## SWING Strategy

**Function:** `evaluateSwingSetup(multiTimeframeData, currentPrice)`  
**Location:** `services/strategy.js` line ~1007

### Gatekeepers (All Must Pass)

1. ✅ **4H trend must NOT be FLAT**
2. ✅ **3D trend must NOT be FLAT**
3. ✅ **1D trend must NOT be FLAT**
4. ✅ **3D pullback** = `OVEREXTENDED` or `RETRACING`
5. ✅ **1D pullback** = `RETRACING` or `ENTRY_ZONE`

### LONG Setup Requirements

```javascript
// HTF Direction: 3D bullish or flat leaning bullish
htf3d: trend3d === 'UPTREND' || 
       (trend3d === 'FLAT' && (stoch3d.condition === 'BULLISH' || stoch3d.condition === 'OVERSOLD'))

// 1D trending down BUT with bullish pivot signs
htf1d: trend1d === 'DOWNTREND' && 
       (stoch1d.condition === 'BULLISH' || stoch1d.k < 25)

// HTF Pullback: 3D overextended below 21EMA (8-15%)
pullback3d: pullback3d.state === 'OVEREXTENDED' && 
            (pullback3d.distanceFrom21EMA < -8 || pullback3d.distanceFrom21EMA > -15)

// Price positioning near 1D EMA21
pricePosition: currentPrice >= (swingLow1d || ema21_1d * 0.90) && 
               currentPrice <= ema21_1d * 1.02

// 4H Confirmation
conf4h: (trend4h === 'UPTREND' || (trend4h === 'FLAT' && stoch4h.condition === 'BULLISH')) &&
        (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE') &&
        Math.abs(currentPrice - ema21_4h) / currentPrice <= 0.01
```

### SHORT Setup Requirements

Mirror of LONG (inverted conditions).

### Entry Zone Calculation

```javascript
// Reclaim level = mid between 1D swing low/high and 1D EMA21
reclaimLevel = (swingLow1d + ema21_1d) / 2;  // LONG
reclaimLevel = (swingHigh1d + ema21_1d) / 2; // SHORT

// Entry zone: ±0.5% around reclaim level
entryMin = reclaimLevel * 0.995;
entryMax = reclaimLevel * 1.005;
```

### Stop Loss Calculation

```javascript
// LONG
stopLoss = Math.min(swingLow3d, swingLow1d);  // HTF invalidation

// SHORT
stopLoss = Math.max(swingHigh3d, swingHigh1d);  // HTF invalidation
```

### Targets Calculation

```javascript
midEntry = (entryMin + entryMax) / 2;
risk = Math.abs(midEntry - stopLoss);

// LONG
tp1 = midEntry + (risk * 3.0);  // 3R
tp2 = midEntry + (risk * 4.0);  // 4R
tp3 = midEntry + (risk * 5.0);  // 5R

// SHORT
tp1 = midEntry - (risk * 3.0);
tp2 = midEntry - (risk * 4.0);
tp3 = midEntry - (risk * 5.0);
```

### Confidence Scoring

- **Base:** Hierarchical confidence system (macro/primary/execution layers)
- **Bonuses:**
  - +5% for strong stoch alignment (3D oversold + 1D bullish)
  - +3% for tight 4H entry (±0.5% from EMA21)
  - +2% for strong 3D overextension (≥10%)
- **Range:** 70-90%

### Data Access

```javascript
const tf3d = multiTimeframeData['3d'];
const tf1d = multiTimeframeData['1d'];
const tf4h = multiTimeframeData['4h'];

// NOTE: Code uses indicators.pullback but structure may be indicators.analysis.pullbackState
// Verify actual structure in API responses
const trend3d = tf3d.indicators?.trend;
const pullback3d = tf3d.indicators?.pullback;  // Verify: may be indicators.analysis.pullbackState
const stoch3d = tf3d.indicators?.stoch;
```

---

## TREND_4H Strategy

**Function:** `evaluateStrategy()` with `setupType = '4h'`  
**Location:** `services/strategy.js` line ~1283

### Gatekeepers

**STANDARD Mode:**
- ✅ 4H trend must NOT be FLAT (hard block)

**AGGRESSIVE Mode:**
- ✅ Can use HTF bias when 4H is FLAT (if confidence ≥ 70%)

### Entry Requirements (LONG)

```javascript
// 4H trend = UPTREND (or effectiveTrend4h = UPTREND in AGGRESSIVE)
trend4h === 'UPTREND'

// Price NOT OVEREXTENDED from 4H 21 EMA
pullbackState !== 'OVEREXTENDED'

// 1H trend NOT DOWNTREND (not breaking down)
trend1h !== 'DOWNTREND'

// 15m/5m stoch NOT both curling down
!(stoch15m.curl === 'down' && stoch5m.curl === 'down')
```

### Entry Zone Calculation

```javascript
// From calculateEntryZone() - line 554
buffer = 0.004;  // 0.4% buffer

// LONG
entryMin = ema21 * 0.996;  // -0.4%
entryMax = ema21 * 1.002;  // +0.2%

// SHORT
entryMin = ema21 * 0.998;  // -0.2%
entryMax = ema21 * 1.004;  // +0.4%
```

### Stop Loss Calculation

```javascript
// From calculateSLTP() - line 586
buffer = 0.003;  // 0.3% buffer
structure = allStructures['4h'] || allStructures['1d'];

// LONG
stopLoss = swingLow ? (swingLow * 0.997) : (entryPrice * 0.97);

// SHORT
stopLoss = swingHigh ? (swingHigh * 1.003) : (entryPrice * 1.03);
```

### Targets Calculation

```javascript
rrTargets = [1.0, 2.0];  // For 4H strategy
entryMid = (entryZone.min + entryZone.max) / 2;

// LONG
risk = entryMid - stopLoss;
tp1 = entryMid + (risk * 1.0);  // 1.0R
tp2 = entryMid + (risk * 2.0);  // 2.0R
```

### Confidence Scoring

Uses hierarchical confidence system:
- **Macro Layer (40%):** 1M, 1W, 3D, 1D alignment
- **Primary Layer (35%):** 4H, 1H alignment
- **Execution Layer (25%):** 15m, 5m, 3m, 1m alignment
- **Penalties:** Applied for contradictions
- **Caps:** Applied based on conflict levels

---

## TREND_RIDER Strategy

**Function:** `evaluateTrendRider(multiTimeframeData, currentPrice, mode)`  
**Location:** `services/strategy.js` line ~2199

### Gatekeepers

- ✅ **HTF bias confidence** ≥ 55% (AGGRESSIVE) or ≥ 65% (STANDARD)
- ✅ **4H trend** NOT DOWNTREND (for longs) or NOT UPTREND (for shorts)
- ✅ **1H trend** must align with direction
- ✅ **Price position** above/below 4H & 1H 21/200 EMAs
- ✅ **1H pullback** in RETRACING or ENTRY_ZONE (not overextended)
- ✅ **4H pullback** not overextended (≤ 3-4.5% from EMA21)
- ✅ **15m/5m Stoch RSI** aligned with trend direction

### Entry Requirements (LONG)

```javascript
// HTF bias long with sufficient confidence
htfBias.direction === 'long' && htfBias.confidence >= minBiasConfidence

// 4H trend aligned (or FLAT in AGGRESSIVE with strong HTF bias)
effectiveTrend4h === 'UPTREND' || (mode === 'AGGRESSIVE' && trend4h !== 'DOWNTREND')

// 1H trend uptrend
trend1h === 'UPTREND'

// Price above EMAs
currentPrice > ema21_1h && currentPrice > ema21_4h && currentPrice > ema200_1h

// 1H pullback valid
pullback1h.state === 'RETRACING' || pullback1h.state === 'ENTRY_ZONE'

// 4H not overextended
Math.abs(pullback4h.dist) <= maxOverextensionPct  // 3% STANDARD, 4.5% AGGRESSIVE

// 15m/5m Stoch aligned
stoch15m.condition === 'BULLISH' || stoch15m.condition === 'OVERSOLD' || stoch15m.k < 40
stoch5m.condition === 'BULLISH' || stoch5m.condition === 'OVERSOLD' || stoch5m.k < 40
```

### Entry Requirements (SHORT)

Mirror of LONG (inverted conditions).

### Entry Zone Calculation

```javascript
// Anchored to 1H EMA21
entryAnchor = ema21_1h;
baseZone = calculateEntryZone(entryAnchor, direction);

// Slightly widened in AGGRESSIVE mode
widenFactor = (mode === 'AGGRESSIVE') ? 1.0015 : 1.0;
entryMin = direction === 'long' ? baseZone.min * widenFactor : baseZone.min / widenFactor;
entryMax = direction === 'long' ? baseZone.max * widenFactor : baseZone.max / widenFactor;
```

### Stop Loss Calculation

```javascript
// Uses 1H + 4H structure
allStructures = {
  '1h': { swingHigh, swingLow },
  '4h': { swingHigh, swingLow },
  '15m': { swingHigh, swingLow },
  '5m': { swingHigh, swingLow }
};

// From calculateSLTP() with setupType = 'TrendRider'
rrTargets = [2.0, 3.5];  // Medium R:R for trend riding
```

### Targets Calculation

```javascript
rrTargets = [2.0, 3.5];  // Trend riding targets
entryMid = (entryMin + entryMax) / 2;

// LONG
risk = entryMid - stopLoss;
tp1 = entryMid + (risk * 2.0);  // 2.0R
tp2 = entryMid + (risk * 3.5);  // 3.5R
```

### Confidence Scoring

Uses hierarchical confidence system with alignment bonuses:
- **Base:** Hierarchical confidence calculation
- **Alignment Bonus:** +5% if macro + primary aligned, +3% if tight pullback
- **Max:** Capped at 90% before hard caps

### Strategy Characteristics

- **Purpose:** Catch and ride strong trends earlier than SWING (not just deep pullbacks)
- **Timeframes:** 4H bias + 1H execution + 15m/5m confirmation
- **Entry Style:** Earlier entries in trends (shallow pullbacks allowed)
- **Risk Profile:** Medium R:R (2R-3.5R targets)
- **Mode Support:** Both STANDARD and AGGRESSIVE

---

## SCALP_1H Strategy

**Function:** `evaluateStrategy()` with `setupType = 'Scalp'`  
**Location:** `services/strategy.js` line ~1650

### Gatekeepers

- ✅ **1H trend must NOT be FLAT**
- ✅ **4H disregarded** (scalp uses 1H bias, works even when 4H FLAT)

### Entry Requirements

```javascript
// 1H trend = UPTREND or DOWNTREND
trend1h !== 'FLAT'

// Price near 1H EMA21 (±2%)
Math.abs(currentPrice - ema21_1h) / ema21_1h <= 0.02

// Price near 15m EMA21 (±1.5%)
Math.abs(currentPrice - ema21_15m) / ema21_15m <= 0.015

// 1H pullback = ENTRY_ZONE or RETRACING
pullback1h.state === 'ENTRY_ZONE' || pullback1h.state === 'RETRACING'

// 15m pullback = ENTRY_ZONE or RETRACING
pullback15m.state === 'ENTRY_ZONE' || pullback15m.state === 'RETRACING'

// 15m stoch aligned with 1H trend direction
// LONG: stoch15m.curl === 'up' or condition === 'BULLISH' or 'OVERSOLD'
// SHORT: stoch15m.curl === 'down' or condition === 'BEARISH' or 'OVERBOUGHT'
```

### Entry Zone Calculation

```javascript
// Uses same formula as TREND_4H (0.4% buffer)
ema21_1h = tf1h.indicators.ema.ema21;
entryZone = calculateEntryZone(ema21_1h, direction);
```

### Stop Loss Calculation

```javascript
// From calculateSLTP() with setupType = 'Scalp'
structure = allStructures['5m'] || allStructures['15m'] || allStructures['4h'];

// LONG
stopLoss = swingLow ? (swingLow * 0.997) : (entryPrice * 0.97);

// SHORT
stopLoss = swingHigh ? (swingHigh * 1.003) : (entryPrice * 1.03);
```

### Targets Calculation

```javascript
rrTargets = [1.5, 3.0];  // Scalp targets
entryMid = (entryZone.min + entryZone.max) / 2;

// LONG
risk = entryMid - stopLoss;
tp1 = entryMid + (risk * 1.5);  // 1.5R
tp2 = entryMid + (risk * 3.0);  // 3.0R
```

### Confidence Scoring

```javascript
// Base confidence: 60
baseConfidence = 60;

// Bias bonus: HTF bias alignment
biasBonus = htfBias.direction === direction ? (htfBias.confidence * 0.1) : 0;

// Final confidence
confidence = Math.min(85, Math.round(baseConfidence + biasBonus));
```

---

## MICRO_SCALP Strategy

**Function:** `evaluateMicroScalp(multiTimeframeData)`  
**Location:** `services/strategy.js` line ~1836

### Gatekeepers (High-Timeframe Guardrails)

1. ✅ **1H trend must NOT be FLAT**
2. ✅ **1H pullback** = `ENTRY_ZONE` or `RETRACING`
3. ✅ **Disregards 4H trend entirely**

### Entry Requirements (LONG)

```javascript
// 1H trend = UPTREND
trend1h === 'UPTREND'

// 15m within ±0.25% of EMA21
Math.abs(pullback15m.distanceFrom21EMA) <= 0.25

// 5m within ±0.25% of EMA21
Math.abs(pullback5m.distanceFrom21EMA) <= 0.25

// 15m pullback = ENTRY_ZONE or RETRACING
pullback15m.state === 'ENTRY_ZONE' || pullback15m.state === 'RETRACING'

// 5m pullback = ENTRY_ZONE or RETRACING
pullback5m.state === 'ENTRY_ZONE' || pullback5m.state === 'RETRACING'

// Stoch momentum aligned:
// Oversold (k<25) OR Bullish with k<40 on both 15m & 5m
(stoch15m.condition === 'OVERSOLD' || stoch15m.k < 25) && 
(stoch5m.condition === 'OVERSOLD' || stoch5m.k < 25)
// OR
(stoch15m.condition === 'BULLISH' && stoch15m.k < 40) && 
(stoch5m.condition === 'BULLISH' && stoch5m.k < 40)
```

### Entry Zone Calculation

```javascript
// Entry = average of 15m & 5m EMA21
entryMid = (ema21_15m + ema21_5m) / 2;

// Entry zone: ±0.1% around entry
entryMin = entryMid * 0.999;
entryMax = entryMid * 1.001;
```

### Stop Loss Calculation

```javascript
// LONG
stopLoss = Math.min(swingLow15m, swingLow5m);

// SHORT
stopLoss = Math.max(swingHigh15m, swingHigh5m);
```

### Targets Calculation

```javascript
risk = Math.abs(entryMid - stopLoss);

// LONG
tp1 = entryMid + (risk * 1.0);  // 1.0R
tp2 = entryMid + (risk * 1.5);  // 1.5R
```

### Confidence Scoring

```javascript
// Base: 60-75 based on confluence tightness
const dist15m = Math.abs(pullback15m.distanceFrom21EMA || 0);
const dist5m = Math.abs(pullback5m.distanceFrom21EMA || 0);
const avgDist = (dist15m + dist5m) / 2;
confidence = Math.max(60, Math.min(75, 75 - (avgDist * 60)));
```

---

## Strategy Evaluation Flow

### Main Entry Point: `evaluateStrategy()`

**Function:** `evaluateStrategy(symbol, multiTimeframeData, setupType, mode)`

**Priority Order:**
1. **SWING** (if `setupType === 'Swing'` or `'auto'`)
2. **TREND_4H** (if `setupType === '4h'` or `'auto'`)
3. **SCALP_1H** (if `setupType === 'Scalp'` or `'auto'`)
4. **AGGRESSIVE strategies** (if `mode === 'AGGRESSIVE'` and no valid trade)
5. **NO_TRADE**

### All Strategies Evaluation: `evaluateAllStrategies()`

**Function:** `evaluateAllStrategies(symbol, multiTimeframeData, mode)`

**Purpose:** Evaluate ALL strategies and return rich object with all results

**Flow:**
1. **HTF Bias Calculation (WITH NULL GUARDS):**
   ```javascript
   let htfBiasRaw = null;
   try {
     htfBiasRaw = computeHTFBias(multiTimeframeData);
   } catch (biasError) {
     console.error(`[evaluateAllStrategies] ${symbol} ERROR computing HTF bias:`, biasError.message);
   }
   const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
   ```

2. **STANDARD Mode 4H FLAT Override Check:**
   - If `mode === 'STANDARD'` AND `4H === 'FLAT'`:
     - Check override conditions:
       - HTF bias confidence >= 60%
       - 1H trend matches HTF bias direction
       - 15m trend matches HTF bias direction
       - 1H Stoch K < 60 (for longs) or > 40 (for shorts)
     - If override conditions met:
       - Set `overrideUsed = true`
       - Set `overrideNotes` with detailed explanation
       - Continue with strategy evaluation
     - If override conditions NOT met:
       - Return all strategies as `NO_TRADE`
       - `bestSignal = null`

3. **Evaluate Each Strategy:**
   - Pass `overrideUsed` and `overrideNotes` to each strategy function
   - `SWING`: `evaluateSwingSetup(..., overrideUsed, overrideNotes)`
   - `TREND_4H`: `evaluateStrategy(..., '4h', mode, ..., overrideUsed, overrideNotes)`
   - `TREND_RIDER`: `evaluateTrendRider(..., overrideUsed, overrideNotes)`
   - `SCALP_1H`: `evaluateStrategy(..., 'Scalp', mode, ..., overrideUsed, overrideNotes)`
   - `MICRO_SCALP`: `evaluateMicroScalp(..., overrideUsed, overrideNotes)`

4. **AGGRESSIVE_MODE Forcing Logic:**
   - If `mode === 'AGGRESSIVE'` AND `4H === 'FLAT'`:
     - Check HTF bias (direction + confidence ≥ 60%)
     - Check 1H/15m trends align with bias
     - **FORCE** at least one strategy to `valid = true` with `override: true` flag

4. **Select Best Signal:**
   - **SAFE_MODE:** TREND_4H → SWING → SCALP_1H → MICRO_SCALP
   - **AGGRESSIVE_MODE:** TREND_4H → SCALP_1H → MICRO_SCALP → SWING
   - Fallback to highest confidence

---

## Confidence Scoring

### Enhanced Hierarchical Confidence System

**Function:** `calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode, strategyName, marketData, dflowData)`

**Strategy-Specific Base Confidence:**
- **SWING:** 80
- **TREND_4H:** 75
- **TREND_RIDER:** 75
- **SCALP_1H:** 70
- **MICRO_SCALP:** 65

**Layers (Applied as Multipliers to Base):**

1. **Macro Trend Layer (40% weight)**
   - Timeframes: 1M, 1W, 3D, 1D
   - Penalties for contradictions
   - Multipliers: 0.75 (mild), 0.6 (moderate), 0.4 (severe)

2. **Primary Trend Layer (35% weight)**
   - Timeframes: 4H, 1H
   - Penalties for contradictions
   - Multipliers: 0.85 (4H flat), 0.5 (4H opposite)

3. **Execution Layer (25% weight)**
   - Timeframes: 15m, 5m, 3m, 1m
   - Exhaustion detection
   - Multipliers: 0.9 (overbought/oversold), 0.7 (multiple exhaustion)

**Hard Caps:**

| Condition | Max Confidence (STANDARD) | Max Confidence (AGGRESSIVE) |
|-----------|---------------------------|-----------------------------|
| ANY macro contradiction | 75% | 80% |
| 4H contradiction | 65% | 70% |
| 1D + 4H contradiction | 55% | 60% |
| 1D opposite + exhaustion | 45% | 50% |

**Return Structure:**
```javascript
{
  confidence: 0-100,
  penaltiesApplied: [{ layer, level, multiplier, reason }],
  capsApplied: ['MACRO_CONTRADICTION'],
  explanation: "Confidence reduced from 92% → 55% due to 1D downtrend contradiction..."
}
```

---

## Data Structure Reference

### Indicator Access Paths

**Current Implementation (Verified):**
```javascript
// Trend
analysis[tf].indicators.analysis.trend

// Pullback State
analysis[tf].indicators.analysis.pullbackState
analysis[tf].indicators.analysis.distanceFrom21EMA

// EMA
analysis[tf].indicators.ema.ema21
analysis[tf].indicators.ema.ema200

// StochRSI
analysis[tf].indicators.stochRSI.k
analysis[tf].indicators.stochRSI.d
analysis[tf].indicators.stochRSI.condition

// Structure
analysis[tf].structure.swingHigh
analysis[tf].structure.swingLow

// Price
analysis[tf].indicators.price.current
```

**Note:** Some code references `indicators.pullback` (e.g., in `evaluateMicroScalp`). This may indicate:
1. Data structure inconsistency
2. Legacy code paths
3. Different data source

**Action Required:** Verify actual API response structure to confirm correct paths.

---

## Strategy JSON Structure

### Canonical Signal Structure

All strategies return this structure:

```javascript
{
  valid: boolean,
  direction: 'long' | 'short' | 'NO_TRADE',
  setupType: 'Swing' | '4h' | 'Scalp' | 'MicroScalp',
  selectedStrategy: 'SWING' | 'TREND_4H' | 'SCALP_1H' | 'MICRO_SCALP',
  strategiesChecked: string[],
  confidence: number,  // 0-100
  reason: string,
  reason_summary: string,
  entryZone: { min: number, max: number },
  stopLoss: number,
  invalidationLevel: number,
  targets: number[],
  riskReward: { tp1RR: number, tp2RR: number, tp3RR?: number },
  riskAmount: number,
  penaltiesApplied: Array<{ layer, level, multiplier, reason }>,
  capsApplied: string[],
  explanation: string,
  confluence: {
    trendAlignment: string,
    stochMomentum: string,
    pullbackState: string,
    liquidityZones: string,
    htfConfirmation: string
  },
  conditionsRequired: string[],
  currentPrice: number,
  timestamp: string,
  htfBias: {
    direction: 'long' | 'short' | 'neutral',
    confidence: number,  // 0-100
    source: string
  }
}
```

---

## Best Practices for Adding New Strategies

See `docs/ADDING_STRATEGIES.md` for complete guide.

**Quick Checklist:**
1. Add evaluation function to `services/strategy.js`
2. Integrate into `evaluateStrategy()` priority order
3. Add to `evaluateAllStrategies()` evaluation list
4. Update `bestSignal` priority logic
5. Add to frontend display (`public/index.html`)
6. Add to JSON exports
7. Document in this guide

---

## Related Documentation

- `docs/INDICATOR_ARCHITECTURE.md` - Indicator system overview
- `docs/STRATEGY_MODES.md` - STANDARD vs AGGRESSIVE mode details
- `docs/STRATEGY_ARCHITECTURE.md` - System architecture
- `docs/ADDING_STRATEGIES.md` - Guide for adding new strategies

---

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0

