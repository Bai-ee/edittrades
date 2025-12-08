# Signal Generation Specification

**Complete Technical Specification for Trade Signal Generation System**

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0  
**Implementation:** `services/strategy.js`, `api/analyze-full.js`

---

## Purpose

This document provides a complete technical specification of how the trading system generates trade signals. It is intended for:
- Third-party developers evaluating or improving the system
- Internal developers maintaining or extending the system
- Technical reviewers auditing signal generation logic

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Data Inputs](#data-inputs)
3. [HTF Bias Computation](#htf-bias-computation)
4. [Strategy Evaluation Flow](#strategy-evaluation-flow)
5. [Strategy Specifications](#strategy-specifications)
6. [Confidence Calculation System](#confidence-calculation-system)
7. [Mode Differences (STANDARD vs AGGRESSIVE)](#mode-differences-standard-vs-aggressive)
8. [Signal Output Structure](#signal-output-structure)
9. [Entry Zone Calculation](#entry-zone-calculation)
10. [Stop Loss & Target Calculation](#stop-loss--target-calculation)

---

## System Overview

The system evaluates multiple trading strategies in priority order, returning the first valid signal found. Each strategy has specific gatekeeper conditions that must be met before evaluation proceeds.

### Strategy Priority Order

**STANDARD Mode:**
1. **SWING** - Multi-timeframe structure (3D → 1D → 4H)
2. **TREND_4H** - 4H trend following
3. **TREND_RIDER** - HTF bias + 4H/1H alignment
4. **SCALP_1H** - 1H trend scalping
5. **MICRO_SCALP** - Tight LTF mean reversion

**AGGRESSIVE Mode:**
1. **SWING** (unchanged)
2. **TREND_RIDER** (can use HTF bias when 4H FLAT)
3. **TREND_4H** (can use HTF bias when 4H FLAT)
4. **SCALP_1H** (looser requirements)
5. **AGGRO_SCALP_1H** (allows 1H FLAT, wider bands)
6. **MICRO_SCALP** (wider EMA bands)
7. **AGGRO_MICRO_SCALP** (even wider bands, one stoch only)

### Evaluation Flow

```
1. Fetch multi-timeframe OHLCV data (1M, 1w, 3d, 1d, 4h, 1h, 15m, 5m, 3m, 1m)
2. Compute indicators for each timeframe (EMA21, EMA200, StochRSI, structure, pullback state)
3. Compute HTF Bias (higher timeframe directional bias)
4. Evaluate strategies in priority order:
   a. Check gatekeeper conditions
   b. If passed, evaluate setup conditions
   c. Calculate confidence with hierarchical system
   d. Apply mode-specific thresholds
   e. If valid, calculate entry zone, stop loss, targets
5. Return first valid signal or NO_TRADE
```

---

## Data Inputs

### Required Timeframes

The system requires OHLCV data for the following timeframes:
- **1M** (1 month) - Optional, used for HTF bias
- **1w** (1 week) - Optional, used for HTF bias
- **3d** (3 days) - Required for SWING strategy
- **1d** (1 day) - Required for SWING strategy
- **4h** (4 hours) - **REQUIRED** - Primary timeframe
- **1h** (1 hour) - Required for SCALP_1H, TREND_RIDER
- **15m** (15 minutes) - Required for SCALP_1H, MICRO_SCALP
- **5m** (5 minutes) - Required for MICRO_SCALP
- **3m** (3 minutes) - Optional
- **1m** (1 minute) - Optional

### Indicators Computed Per Timeframe

For each timeframe, the system computes:

```javascript
{
  price: {
    current: number,           // Current price
    high: number,             // Recent high
    low: number               // Recent low
  },
  ema: {
    ema21: number,            // 21-period EMA
    ema200: number            // 200-period EMA (if available)
  },
  stochRSI: {
    k: number,                // %K value (0-100)
    d: number,                // %D value (0-100)
    condition: string         // 'OVERSOLD' | 'OVERBOUGHT' | 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  },
  analysis: {
    trend: string,            // 'UPTREND' | 'DOWNTREND' | 'FLAT'
    pullbackState: string,    // 'OVEREXTENDED' | 'RETRACING' | 'ENTRY_ZONE' | 'TRENDING'
    distanceFrom21EMA: number // Percentage distance from EMA21
  },
  structure: {
    swingHigh: number,        // Recent swing high
    swingLow: number          // Recent swing low
  }
}
```

### Market Data (Optional)

```javascript
{
  volumeQuality: string,      // 'HIGH' | 'MEDIUM' | 'LOW'
  currentVolume: number,
  avgVolume20: number
}
```

### dFlow Data (Optional)

```javascript
{
  direction: string,          // 'long' | 'short' | 'neutral'
  confidence: number          // 0-100
}
```

---

## HTF Bias Computation

**Function:** `computeHTFBias(timeframes)`  
**Location:** `services/strategy.js` line ~269

HTF Bias provides a higher timeframe directional bias when lower timeframes are unclear (e.g., 4H is FLAT).

### Computation Logic

The system uses a scoring mechanism based on 4H and 1H timeframes:

1. **Score Calculation:**
   - **4H trend UPTREND:** longScore += 2
   - **4H trend DOWNTREND:** shortScore += 2
   - **1H trend UPTREND:** longScore += 1
   - **1H trend DOWNTREND:** shortScore += 1
   - **4H Stoch BULLISH/OVERSOLD:** longScore += 0.5
   - **4H Stoch BEARISH/OVERBOUGHT:** shortScore += 0.5
   - **1H Stoch BULLISH/OVERSOLD:** longScore += 0.5
   - **1H Stoch BEARISH/OVERBOUGHT:** shortScore += 0.5

2. **Bias Determination:**
   - If longScore > shortScore:
     - direction = 'long'
     - confidence = min(100, round((longScore / (longScore + shortScore)) * 100))
     - source = '4h' if 4H trend not flat, else '1h'
   - If shortScore > longScore:
     - direction = 'short'
     - confidence = min(100, round((shortScore / (longScore + shortScore)) * 100))
     - source = '4h' if 4H trend not flat, else '1h'
   - If longScore === shortScore (tie):
     - Use 1H trend as tie-breaker if available
     - Otherwise use 4H trend as tie-breaker
     - If both flat → direction = 'neutral', confidence = 0, source = 'mixed'

3. **Fallback:**
   - If 4H or 1H data missing → bias = 'neutral', confidence = 0, source = 'none'

### Output Structure

```javascript
{
  direction: 'long' | 'short' | 'neutral',
  confidence: number,         // 0-100
  source: string              // '1d' | '3d' | '1w' | '1m' | 'fallback'
}
```

### Usage

HTF Bias is used to:
- Override 4H FLAT blocks in AGGRESSIVE mode
- Provide directional context when lower timeframes are unclear
- Boost confidence when aligned with signal direction
- Penalize confidence when counter to signal direction

---

## Strategy Evaluation Flow

### Main Entry Point

**Function:** `evaluateStrategy(symbol, multiTimeframeData, setupType, mode, marketData, dflowData, overrideUsed)`  
**Location:** `services/strategy.js` line ~1799

### Evaluation Steps

1. **Validate 4H data exists** - If missing, return NO_TRADE
2. **Compute HTF Bias** - Used throughout evaluation
3. **Normalize trends** - Convert to lowercase ('uptrend' | 'downtrend' | 'flat')
4. **Evaluate strategies in priority order:**
   - SWING (if setupType is 'Swing' or 'auto')
   - TREND_4H (if setupType is '4h' or 'auto')
   - TREND_RIDER (if setupType is 'TrendRider' or 'auto')
   - SCALP_1H (if setupType is 'Scalp' or 'auto')
   - MICRO_SCALP (if setupType is 'auto')
   - AGGRESSIVE variants (if mode is 'AGGRESSIVE')
5. **Return first valid signal or NO_TRADE**

---

## Strategy Specifications

### 1. SWING Strategy

**Function:** `evaluateSwingSetup(multiTimeframeData, currentPrice, mode, marketData, dflowData, overrideUsed)`  
**Location:** `services/strategy.js` line ~1476

#### Gatekeepers (ALL Must Pass)

1. ✅ **4H trend must NOT be FLAT** (unless override used)
2. ✅ **3D trend must NOT be FLAT**
3. ✅ **1D trend must NOT be FLAT**
4. ✅ **3D pullback state** = `OVEREXTENDED` or `RETRACING`
5. ✅ **1D pullback state** = `RETRACING` or `ENTRY_ZONE`

#### LONG Setup Requirements

All of the following must be true:

```javascript
// HTF Direction: 3D bullish or flat leaning bullish
htf3d: trend3d === 'uptrend' || 
       (trend3d === 'flat' && (stoch3d.condition === 'BULLISH' || stoch3d.condition === 'OVERSOLD'))

// 1D trending down BUT with bullish pivot signs
htf1d: trend1d === 'downtrend' && 
       (stoch1d.condition === 'BULLISH' || stoch1d.k < 25)

// HTF Pullback: 3D overextended below 21EMA
pullback3d: pullback3d.state === 'OVEREXTENDED' && 
            (pullback3d.distanceFrom21EMA < -8 || pullback3d.distanceFrom21EMA > -15)

// 1D pullback
pullback1d: pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE'

// Price positioning near 1D EMA21
pricePosition: currentPrice >= (swingLow1d || ema21_1d * 0.90) && 
               currentPrice <= ema21_1d * 1.02

// 4H Confirmation
conf4h: (trend4h === 'uptrend' || (trend4h === 'flat' && stoch4h.condition === 'BULLISH')) &&
        (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE')
```

#### SHORT Setup Requirements

Mirror of LONG (inverted conditions).

#### Entry Zone

- **Reclaim level** = midpoint between 1D swing low/high and 1D EMA21
- **Entry zone** = reclaim level ±0.5%
- **Entry type** = 'pullback' (STANDARD) or 'breakout' (AGGRESSIVE)

#### Stop Loss

- **LONG:** Minimum of 3D swing low and 1D swing low
- **SHORT:** Maximum of 3D swing high and 1D swing high

#### Targets

- **TP1:** 3R (3x risk)
- **TP2:** 4R (4x risk)
- **TP3:** 5R (5x risk)

#### Confidence

- **Base:** 80% (SWING strategy base)
- **Minimum:** 60%
- **Bonuses:**
  - +5% for strong stoch alignment (3D oversold + 1D bullish)
  - +3% for tight 4H entry (within ±0.5% of EMA21)
  - +2% for strong 3D overextension (≥10%)
- **Caps:** Subject to hierarchical confidence system

---

### 2. TREND_4H Strategy

**Function:** `evaluateStrategy()` - 4H trend section  
**Location:** `services/strategy.js` line ~1876

#### Gatekeepers

1. ✅ **4H trend must NOT be FLAT** (STANDARD mode)
   - **Exception:** AGGRESSIVE mode can use HTF bias override if:
     - HTF bias confidence ≥ 60%
     - HTF bias direction matches signal direction
     - 1H/15m trends align with HTF bias

#### Setup Requirements

**LONG:**
```javascript
// 4H trend
trend4h === 'uptrend'

// Price near 4H EMA21 (within ±2%)
Math.abs(currentPrice - ema21_4h) / currentPrice <= 0.02

// 4H pullback state
pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE'

// 4H Stoch alignment
stoch4h.condition === 'BULLISH' || stoch4h.condition === 'OVERSOLD' || stoch4h.k < 60

// 1H confirmation (not breaking structure)
trend1h === 'uptrend' || (trend1h === 'flat' && stoch1h.condition === 'BULLISH')
```

**SHORT:** Mirror of LONG (inverted conditions).

#### Entry Zone

- **STANDARD mode:** Prioritizes breakout entry if price near swing level with momentum, otherwise pullback entry
- **AGGRESSIVE mode:** Always uses aggressive entry (close to or ahead of price)
- **Pullback entry:** EMA21 ±1%
- **Breakout entry:** Near swing high/low with momentum confirmation

#### Stop Loss

- **LONG:** 4H swing low (or 1H swing low if closer)
- **SHORT:** 4H swing high (or 1H swing high if closer)

#### Targets

- **TP1:** 1R (1x risk)
- **TP2:** 2R (2x risk)

#### Confidence

- **Base:** 75% (TREND_4H strategy base)
- **Minimum:** 60% (STANDARD) or 50% (AGGRESSIVE)
- **Penalties:**
  - -3% if EMA distance 1-2% (still allowed)
  - Blocked if EMA distance >2%
- **Caps:** Subject to hierarchical confidence system

---

### 3. TREND_RIDER Strategy

**Function:** `evaluateTrendRider(multiTimeframeData, currentPrice, mode, marketData, dflowData)`  
**Location:** `services/strategy.js` (separate function)

#### Gatekeepers

1. ✅ **HTF bias confidence** ≥ 65% (STANDARD) or ≥ 55% (AGGRESSIVE)
2. ✅ **HTF bias direction** matches signal direction
3. ✅ **4H/1H trend alignment** with HTF bias (or 4H can be FLAT in AGGRESSIVE)

#### Setup Requirements

**LONG:**
```javascript
// HTF bias
htfBias.direction === 'long' && htfBias.confidence >= threshold

// 4H/1H alignment
(trend4h === 'uptrend' || (trend4h === 'flat' && mode === 'AGGRESSIVE')) &&
trend1h === 'uptrend'

// Price above 4H & 1H EMAs
currentPrice > ema21_4h && currentPrice > ema21_1h

// Shallow pullback allowed
pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE'

// 15m/5m Stoch alignment
stoch15m.condition === 'BULLISH' || stoch15m.condition === 'OVERSOLD'
```

**SHORT:** Mirror of LONG (inverted conditions).

#### Entry Zone

- Shallow pullback entry (RETRACING/ENTRY_ZONE)
- Entry zone slightly widened in AGGRESSIVE mode (1.0015x factor)

#### Stop Loss

- **LONG:** 1H swing low (or 4H swing low if closer)
- **SHORT:** 1H swing high (or 4H swing high if closer)

#### Targets

- **TP1:** 2R (2x risk)
- **TP2:** 3.5R (3.5x risk)

#### Confidence

- **Base:** 75% (TREND_RIDER strategy base)
- **Minimum:** 60% (STANDARD) or 50% (AGGRESSIVE)
- **Bonuses:** HTF bias alignment bonus
- **Caps:** Subject to hierarchical confidence system

---

### 4. SCALP_1H Strategy

**Function:** `evaluateStrategy()` - SCALP_1H section  
**Location:** `services/strategy.js` line ~2290

#### Gatekeepers

1. ✅ **1H trend must NOT be FLAT**
2. ✅ **4H trend** - Blocked if 4H is FLAT (STANDARD), allowed if HTF bias strong (AGGRESSIVE)
3. ✅ **Price near 1H EMA21** (within ±2%)
4. ✅ **Price near 15m EMA21** (within ±1.5%)
5. ✅ **1H pullback state** = `ENTRY_ZONE` or `RETRACING`
6. ✅ **15m pullback state** = `ENTRY_ZONE` or `RETRACING`

#### Setup Requirements

**LONG:**
```javascript
// 1H trend
trend1h === 'uptrend'

// Price positioning
Math.abs(currentPrice - ema21_1h) / currentPrice <= 0.02 &&
Math.abs(currentPrice - ema21_15m) / currentPrice <= 0.015

// Pullback states
pullback1h.state === 'ENTRY_ZONE' || pullback1h.state === 'RETRACING' &&
pullback15m.state === 'ENTRY_ZONE' || pullback15m.state === 'RETRACING'

// 15m Stoch alignment
stoch15m.condition === 'BULLISH' || stoch15m.condition === 'OVERSOLD' || stoch15m.k < 60
```

**SHORT:** Mirror of LONG (inverted conditions).

#### Entry Zone

- **STANDARD mode:** Prioritizes breakout entry, otherwise pullback entry
- **AGGRESSIVE mode:** Always uses aggressive entry
- **Pullback entry:** 1H EMA21 ±1%

#### Stop Loss

- **LONG:** 15m swing low (or 5m swing low if closer)
- **SHORT:** 15m swing high (or 5m swing high if closer)

#### Targets

- **TP1:** 1.5R (1.5x risk)
- **TP2:** 3R (3x risk)

#### Confidence

- **Base:** 70% (SCALP_1H strategy base)
- **Minimum:** 60% (STANDARD) or 50% (AGGRESSIVE)
- **Bonuses:**
  - HTF bias alignment bonus (htfBias.confidence * 0.1)
- **Blocks:**
  - Counter-trend scalps blocked when HTF bias ≥ 70% and opposite direction
- **Caps:** Subject to hierarchical confidence system

---

### 5. MICRO_SCALP Strategy

**Function:** `evaluateMicroScalp(multiTimeframeData, marketData, dflowData, overrideUsed)`  
**Location:** `services/strategy.js` line ~2618

#### Gatekeepers

1. ✅ **1H trend must NOT be FLAT**
2. ✅ **1H pullback state** = `ENTRY_ZONE` or `RETRACING`
3. ✅ **15m price near EMA21** (within ±0.25% STANDARD, ±0.75% AGGRESSIVE)
4. ✅ **5m price near EMA21** (within ±0.25% STANDARD, ±0.75% AGGRESSIVE)

#### Setup Requirements

**LONG:**
```javascript
// 1H trend
trend1h === 'uptrend'

// Price positioning (tight confluence)
Math.abs(pullback15m.distanceFrom21EMA) <= 0.25 &&  // STANDARD: 0.25%, AGGRESSIVE: 0.75%
Math.abs(pullback5m.distanceFrom21EMA) <= 0.25 &&   // STANDARD: 0.25%, AGGRESSIVE: 0.75%
pullback15m.state === 'ENTRY_ZONE' || pullback15m.state === 'RETRACING' &&
pullback5m.state === 'ENTRY_ZONE' || pullback5m.state === 'RETRACING'

// Stoch alignment (BOTH required in STANDARD, ONE required in AGGRESSIVE)
// STANDARD:
(stoch15m.condition === 'OVERSOLD' || stoch15m.k < 25) &&
(stoch5m.condition === 'OVERSOLD' || stoch5m.k < 25)
// OR
(stoch15m.condition === 'BULLISH' && stoch15m.k < 40) &&
(stoch5m.condition === 'BULLISH' && stoch5m.k < 40)

// AGGRESSIVE: Only ONE stoch needs to be oversold/bullish
```

**SHORT:** Mirror of LONG (inverted conditions).

#### Entry Zone

- Entry = average of 15m EMA21 and 5m EMA21
- Entry zone = entry ±0.5%

#### Stop Loss

- **LONG:** Minimum of 15m swing low and 5m swing low
- **SHORT:** Maximum of 15m swing high and 5m swing high

#### Targets

- **TP1:** 1R (1x risk)
- **TP2:** 1.5R (1.5x risk)

#### Confidence

- **Base:** 65% (MICRO_SCALP strategy base)
- **Minimum:** 60%
- **Bonuses:**
  - +5% if average EMA distance < 0.5%
  - +3% if average EMA distance < 1.0%
- **Soft blocks:**
  - Volume quality LOW + confidence < 60% = no signal
- **Caps:** Subject to hierarchical confidence system

---

## Confidence Calculation System

**Function:** `calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode, strategyName, marketData, dflowData)`  
**Location:** `services/strategy.js` line ~902

### Base Confidence by Strategy

| Strategy | Base Confidence |
|----------|----------------|
| SWING | 80% |
| TREND_4H | 75% |
| TREND_RIDER | 75% |
| SCALP_1H | 70% |
| MICRO_SCALP | 65% |

### Hierarchical Confidence Layers

The system applies confidence adjustments in layers:

#### Layer 1: Base Confidence
- Set by strategy type (see table above)

#### Layer 2: Trend Alignment Bonuses
- **4H trend aligns:** +5%
- **1H trend aligns:** +3%
- **15m trend aligns:** +2%
- **5m trend aligns:** +1%

#### Layer 3: Stoch Alignment Bonuses
- **4H stoch aligns:** +3%
- **1H stoch aligns:** +2%
- **15m stoch aligns:** +1%
- **5m stoch aligns:** +1%

#### Layer 4: HTF Bias Alignment
- **HTF bias matches direction:**
  - Confidence boost = htfBias.confidence * 0.15 (max +10%)
- **HTF bias opposes direction:**
  - Confidence penalty = -(htfBias.confidence * 0.20) (max -15%)

#### Layer 5: Volume Quality Filter
- **HIGH volume:** No penalty
- **MEDIUM volume:** -2%
- **LOW volume:** -5% (soft block if confidence < 60%)

#### Layer 6: dFlow Alignment
- **dFlow matches direction:**
  - Confidence boost = dFlow.confidence * 0.10 (max +5%)
- **dFlow opposes direction:**
  - Confidence penalty = -(dFlow.confidence * 0.15) (max -7%)

#### Layer 7: Macro Contradictions (Caps)

Confidence is capped based on macro contradictions:

| Condition | STANDARD Cap | AGGRESSIVE Cap |
|----------|-------------|----------------|
| ANY macro contradiction | 75% | 80% |
| 4H contradiction | 65% | 70% |
| 1D + 4H contradiction | 55% | 60% |
| 1D opposite + exhaustion | 45% | 50% |

**Macro contradictions:**
- 1D trend opposite to signal direction
- 4H trend opposite to signal direction
- 1D/4H both opposite to signal direction
- 1D opposite + stoch showing exhaustion

#### Layer 8: Strategy-Specific Adjustments

Each strategy applies additional adjustments:
- **SWING:** Stoch alignment bonus, tight entry bonus, overextension bonus
- **TREND_4H:** EMA distance penalty
- **SCALP_1H:** HTF bias bonus, counter-trend block
- **MICRO_SCALP:** Confluence bonus, volume quality soft block

### Final Confidence

```javascript
confidence = baseConfidence
  + trendAlignmentBonuses
  + stochAlignmentBonuses
  + htfBiasAdjustment
  + volumeQualityAdjustment
  + dFlowAdjustment
  + strategySpecificAdjustments

// Apply caps
confidence = Math.min(confidence, macroContradictionCap)

// Apply minimum threshold
if (confidence < minConfidence && !override) {
  return NO_TRADE
}
```

---

## Mode Differences (STANDARD vs AGGRESSIVE)

### Thresholds Object

```javascript
const THRESHOLDS = {
  STANDARD: {
    emaPullbackMax: 1.0,        // Maximum distance from EMA21 (%)
    microScalpEmaBand: 0.25,    // EMA band for micro-scalp (±%)
    allowFlat4HForScalp: false, // Allow scalps when 4H is FLAT
    minHtfBiasConfidence: 60    // Minimum HTF bias confidence
  },
  AGGRESSIVE: {
    emaPullbackMax: 1.75,       // Wider pullback zone
    microScalpEmaBand: 0.75,   // Wider EMA band
    allowFlat4HForScalp: true,  // Allow scalps when 4H is FLAT
    minHtfBiasConfidence: 40    // Lower confidence threshold
  }
};
```

### Key Differences

| Feature | STANDARD | AGGRESSIVE |
|---------|----------|------------|
| **4H FLAT override** | Requires HTF bias ≥ 60% + 1H/15m alignment | Allows HTF bias ≥ 40% |
| **TREND_4H** | Blocked if 4H FLAT | Can use HTF bias when 4H FLAT |
| **SCALP_1H** | Blocked if 4H FLAT | Allowed if HTF bias strong |
| **AGGRO_SCALP_1H** | Not available | Allows 1H FLAT, wider bands |
| **MICRO_SCALP EMA band** | ±0.25% | ±0.75% |
| **AGGRO_MICRO_SCALP** | Not available | ±0.75% band, one stoch only |
| **Minimum confidence** | 60% | 50% |
| **Confidence caps** | Lower (see table) | Higher (see table) |
| **Position sizing** | 1% risk | 0.5% (scalps), 0.33% (micro) |

---

## Signal Output Structure

### Valid Signal

```javascript
{
  valid: true,
  symbol: string,
  direction: 'long' | 'short',
  setupType: 'Swing' | '4h' | 'Scalp' | 'TrendRider' | 'MicroScalp',
  selectedStrategy: 'SWING' | 'TREND_4H' | 'SCALP_1H' | 'TREND_RIDER' | 'MICRO_SCALP',
  strategiesChecked: string[],
  confidence: number,              // 0-100
  reason: string,
  reason_summary: string,
  entryType: 'pullback' | 'breakout',
  entryZone: {
    min: number,
    max: number
  },
  stopLoss: number,
  invalidationLevel: number,
  targets: [number, number],      // [TP1, TP2] or [TP1, TP2, TP3] for SWING
  riskReward: {
    tp1RR: number,
    tp2RR: number,
    tp3RR?: number                 // SWING only
  },
  riskAmount: number,
  penaltiesApplied: Array<{
    layer: string,
    reason: string,
    multiplier: number
  }>,
  capsApplied: Array<{
    layer: string,
    reason: string,
    cap: number
  }>,
  explanation: string,
  confidenceBreakdown: {
    base: number,
    adjustments: Array<{
      type: string,
      value: number,
      reason: string
    }>,
    final: number
  },
  confluence: {
    trendAlignment: string,
    stochMomentum: string,
    pullbackState: string,
    liquidityZones: string,
    htfConfirmation: string
  },
  conditionsRequired: string[],
  trend: {
    '3d': string,
    '1d': string,
    '4h': string,
    '1h': string,
    '15m': string,
    '5m': string
  },
  stoch: {
    '4h': object,
    '1h': object,
    '15m': object,
    '5m': object
  },
  currentPrice: number,
  ema21: number,
  ema200: number | null,
  htfBias: {
    direction: 'long' | 'short' | 'neutral',
    confidence: number,
    source: string
  },
  timestamp: string,
  mode: 'STANDARD' | 'AGGRESSIVE',
  override: boolean,
  notes: string[]
}
```

### NO_TRADE Signal

```javascript
{
  valid: false,
  symbol: string,
  direction: 'NO_TRADE',
  setupType: 'auto',
  selectedStrategy: 'NO_TRADE',
  strategiesChecked: string[],
  confidence: 0,
  reason: string,
  reason_summary: string,
  entryZone: { min: null, max: null },
  stopLoss: null,
  invalidationLevel: null,
  targets: [null, null],
  riskReward: { tp1RR: null, tp2RR: null },
  trend: object,
  stoch: object,
  htfBias: object,
  timestamp: string,
  mode: 'STANDARD' | 'AGGRESSIVE'
}
```

---

## Entry Zone Calculation

### Pullback Entry

**Function:** `calculateEntryZone(ema21, direction)`

```javascript
// LONG
entryMin = ema21 * 0.99   // 1% below EMA21
entryMax = ema21 * 1.01   // 1% above EMA21

// SHORT
entryMin = ema21 * 0.99   // 1% below EMA21
entryMax = ema21 * 1.01   // 1% above EMA21
```

### Breakout Entry

**Function:** `calculateBreakoutEntryZone(swingLevel, direction, currentPrice)`

```javascript
// LONG (breakout above swing high)
entryMin = swingLevel * 1.0005   // 0.05% above swing high
entryMax = swingLevel * 1.002    // 0.2% above swing high

// SHORT (breakdown below swing low)
entryMin = swingLevel * 0.998    // 0.2% below swing low
entryMax = swingLevel * 0.9995   // 0.05% below swing low
```

### Aggressive Entry (AGGRESSIVE Mode Only)

**Function:** `calculateAggressiveEntryZone(currentPrice, direction)`

```javascript
// LONG
entryMin = currentPrice * 1.0001   // 0.01% above current price
entryMax = currentPrice * 1.0005   // 0.05% above current price

// SHORT
entryMin = currentPrice * 0.9995   // 0.05% below current price
entryMax = currentPrice * 0.9999   // 0.01% below current price
```

---

## Stop Loss & Target Calculation

**Function:** `calculateSLTP(entryMid, direction, allStructures, setupType, rrTargets)`

### Stop Loss Selection

The system selects the stop loss from available swing levels:

**LONG:**
1. 5m swing low (if available and closest)
2. 15m swing low (if available)
3. 1H swing low (if available)
4. 4H swing low (if available)
5. 1D swing low (if available)
6. 3D swing low (if available)

**SHORT:**
1. 5m swing high (if available and closest)
2. 15m swing high (if available)
3. 1H swing high (if available)
4. 4H swing high (if available)
5. 1D swing high (if available)
6. 3D swing high (if available)

### Target Calculation

```javascript
const R = Math.abs(entryMid - stopLoss);

// LONG
tp1 = entryMid + (R * rrTargets[0])
tp2 = entryMid + (R * rrTargets[1])
tp3 = entryMid + (R * rrTargets[2])  // SWING only

// SHORT
tp1 = entryMid - (R * rrTargets[0])
tp2 = entryMid - (R * rrTargets[1])
tp3 = entryMid - (R * rrTargets[2])  // SWING only
```

### R:R Targets by Strategy

| Strategy | TP1 | TP2 | TP3 |
|----------|-----|-----|-----|
| SWING | 3R | 4R | 5R |
| TREND_4H | 1R | 2R | - |
| TREND_RIDER | 2R | 3.5R | - |
| SCALP_1H | 1.5R | 3R | - |
| MICRO_SCALP | 1R | 1.5R | - |

---

## Implementation Notes

### Data Validation

All signals are validated before being marked as `valid: true`:

1. Entry zone must be valid (min < max, both numbers)
2. Stop loss must be valid number
3. Invalidation level must be valid number
4. At least one target must be valid number
5. Direction must not be 'NO_TRADE'
6. Confidence must be 0-100
7. Stop loss must be logically correct for direction:
   - LONG: stopLoss < entryZone.min
   - SHORT: stopLoss > entryZone.max

### Error Handling

- If 4H data is missing → return NO_TRADE
- If any required timeframe data is missing → strategy returns null, next strategy evaluated
- If confidence calculation fails → confidence = 0, signal marked invalid
- If HTF bias computation fails → htfBias = { direction: 'neutral', confidence: 0, source: 'fallback' }

### Performance Considerations

- Strategies evaluated in priority order (most restrictive first)
- First valid signal found is returned (no further evaluation)
- HTF bias computed once and reused
- Confidence calculation cached where possible

---

## Related Documentation

- `STRATEGY_MODES.md` - STANDARD vs AGGRESSIVE mode differences
- `STRATEGY_IMPLEMENTATION_GUIDE.md` - Strategy implementation details
- `COMPLETE_DATA_REFERENCE.md` - Data structure reference
- `SYSTEM_WORKFLOW.md` - End-to-end system workflow

---

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0  
**Maintained By:** Development Team
