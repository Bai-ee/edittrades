# Strategy System Audit - Complete Breakdown

**Generated:** 2025-01-XX  
**Purpose:** Comprehensive audit of all trading strategies, their evaluation logic, frontend display, and JSON output to identify inconsistencies.

---

## Table of Contents

1. [Strategy Definitions](#strategy-definitions)
2. [Backend Evaluation Flow](#backend-evaluation-flow)
3. [Frontend Evaluation Flow](#frontend-evaluation-flow)
4. [JSON Output Structure](#json-output-structure)
5. [Data Flow Diagram](#data-flow-diagram)
6. [Identified Inconsistencies](#identified-inconsistencies)
7. [API Endpoints](#api-endpoints)

---

## Strategy Definitions

### 1. SWING Strategy
**Location:** `services/strategy.js` - `evaluateSwingSetup()` (line 742)

**Timeframes:** 3D → 1D → 4H

**Gatekeepers:**
- ❌ 4H trend must NOT be FLAT
- ❌ 3D trend must NOT be FLAT
- ❌ 1D trend must NOT be FLAT
- ❌ 3D pullback must be OVEREXTENDED or RETRACING
- ❌ 1D pullback must be RETRACING or ENTRY_ZONE

**Entry Requirements (LONG):**
- 3D trend = UPTREND OR (FLAT + stoch BULLISH/OVERSOLD)
- 1D trend = DOWNTREND + stoch BULLISH (k < 25)
- 3D pullback = OVEREXTENDED (8-15% below 21 EMA)
- Price near 1D EMA21 (90-102%)
- 4H confirmation = UPTREND or (FLAT + stoch BULLISH) + pullback RETRACING/ENTRY_ZONE

**Entry Requirements (SHORT):**
- Mirror of LONG (inverted)

**Entry Zone Calculation:**
```javascript
// From evaluateSwingSetup() - line ~850
reclaimLevel = (swing1d + ema21_1d) / 2;
entryMin = reclaimLevel * 0.995;  // -0.5%
entryMax = reclaimLevel * 1.005;  // +0.5%
```

**Stop Loss Calculation:**
```javascript
// LONG
stopLoss = Math.min(swingLow3d, swingLow1d);  // HTF invalidation

// SHORT
stopLoss = Math.max(swingHigh3d, swingHigh1d);  // HTF invalidation
```

**Targets Calculation:**
```javascript
// From evaluateSwingSetup() - line ~900
entryMid = (entryMin + entryMax) / 2;
risk = direction === 'long' ? (entryMid - stopLoss) : (stopLoss - entryMid);

// LONG
tp1 = entryMid + (risk * 3.0);  // 3R
tp2 = entryMid + (risk * 4.0);  // 4R
tp3 = entryMid + (risk * 5.0);  // 5R

// SHORT
tp1 = entryMid - (risk * 3.0);  // 3R
tp2 = entryMid - (risk * 4.0);  // 4R
tp3 = entryMid - (risk * 5.0);  // 5R
```

**Confidence Calculation:**
```javascript
// Base confidence: 70
// +10 if strong stoch alignment
// +5 if tight 4H entry
// +5 if strong 3D overextension
// Range: 70-90%
```

**Strategy Name in JSON:** `SWING`

---

### 2. TREND_4H Strategy
**Location:** `services/strategy.js` - `evaluateStrategy()` (line 1119-1329)

**Timeframes:** 4H → 1H → 15m/5m

**Gatekeepers:**
- **SAFE_MODE:** 4H trend must NOT be FLAT (hard block)
- **AGGRESSIVE_MODE:** Can use HTF bias when 4H is FLAT (if confidence >= 70%)

**Entry Requirements (LONG):**
- 4H trend = UPTREND (or effectiveTrend4h = UPTREND in AGGRESSIVE)
- Price NOT OVEREXTENDED from 4H 21 EMA
- 1H trend NOT DOWNTREND (not breaking down)
- 15m/5m stoch NOT both curling down

**Entry Requirements (SHORT):**
- Mirror of LONG (inverted)

**Entry Zone Calculation:**
```javascript
// From calculateEntryZone() - line 537
buffer = 0.004;  // 0.4% buffer

// LONG
entryMin = ema21 * (1 - 0.004);      // ema21 * 0.996
entryMax = ema21 * (1 + 0.002);      // ema21 * 1.002

// SHORT
entryMin = ema21 * (1 - 0.002);      // ema21 * 0.998
entryMax = ema21 * (1 + 0.004);      // ema21 * 1.004
```

**Stop Loss Calculation:**
```javascript
// From calculateSLTP() - line 569
buffer = 0.003;  // 0.3% buffer
structure = allStructures['4h'] || allStructures['1d'];

// LONG
stopLoss = swingLow ? (swingLow * (1 - 0.003)) : (entryPrice * 0.97);
invalidationLevel = swingLow || (entryPrice * 0.97);

// SHORT
stopLoss = swingHigh ? (swingHigh * (1 + 0.003)) : (entryPrice * 1.03);
invalidationLevel = swingHigh || (entryPrice * 1.03);
```

**Targets Calculation:**
```javascript
// From calculateSLTP() - line 569
entryMid = (entryZone.min + entryZone.max) / 2;
rrTargets = [1.0, 2.0];  // For 4H strategy

// LONG
risk = entryMid - stopLoss;
tp1 = entryMid + (risk * 1.0);  // 1.0R
tp2 = entryMid + (risk * 2.0);  // 2.0R

// SHORT
risk = stopLoss - entryMid;
tp1 = entryMid - (risk * 1.0);  // 1.0R
tp2 = entryMid - (risk * 2.0);  // 2.0R
```

**Confidence Calculation:**
```javascript
// From calculateConfidence() - line 631
// Returns 0-1 scale, then converted to 0-100
score = 0;

// 1. 4H trend alignment (0-0.4)
if (direction === 'long' && trend4h === 'UPTREND') score += 0.4;
else if (direction === 'short' && trend4h === 'DOWNTREND') score += 0.4;
else if (trend4h === 'FLAT') score += 0.1;

// 2. 1H confirmation (0-0.2)
if (direction === 'long' && trend1h === 'UPTREND') score += 0.2;
else if (direction === 'short' && trend1h === 'DOWNTREND') score += 0.2;
else if (trend1h === 'FLAT') score += 0.1;

// 3. Stoch alignment (0-0.2)
if (stoch15m.curl === 'up' && stoch5m.curl === 'up') score += 0.2;
else if (stoch15m.curl === 'up' || stoch5m.curl === 'up') score += 0.1;

// 4. Structure confluence (0-0.1)
if (price in good position) score += 0.1;

// 5. MA confluence (0-0.1)
if (pullbackState === 'ENTRY_ZONE') score += 0.1;
else if (pullbackState === 'RETRACING') score += 0.05;

confidence = Math.round(score * 100);  // Convert to 0-100 scale
```

**Strategy Name in JSON:** `TREND_4H`

---

### 3. SCALP_1H Strategy
**Location:** `services/strategy.js` - `evaluateStrategy()` (line 1331-1447)

**Timeframes:** 1H → 15m → 5m

**Gatekeepers:**
- 1H trend must NOT be FLAT
- 4H disregarded (scalp uses 1H bias)

**Entry Requirements:**
- 1H trend = UPTREND or DOWNTREND
- Price near 1H EMA21 (±2%)
- Price near 15m EMA21 (±1.5%)
- 1H pullback = ENTRY_ZONE or RETRACING
- 15m pullback = ENTRY_ZONE or RETRACING
- 15m stoch aligned with 1H trend direction

**Entry Zone Calculation:**
```javascript
// From evaluateStrategy() - line 1363
ema21_1h = tf1h.indicators.ema.ema21;
entryZone = calculateEntryZone(ema21_1h, direction);
// Uses same formula as TREND_4H (0.4% buffer)
```

**Stop Loss Calculation:**
```javascript
// From calculateSLTP() - line 569 (setupType = 'Scalp')
structure = allStructures['5m'] || allStructures['15m'] || allStructures['4h'];

// LONG
stopLoss = swingLow ? (swingLow * (1 - 0.003)) : (entryPrice * 0.97);

// SHORT
stopLoss = swingHigh ? (swingHigh * (1 + 0.003)) : (entryPrice * 1.03);
```

**Targets Calculation:**
```javascript
// From evaluateStrategy() - line 1374
rrTargets = [1.5, 3.0];  // Scalp targets
entryMid = (entryZone.min + entryZone.max) / 2;

// LONG
risk = entryMid - stopLoss;
tp1 = entryMid + (risk * 1.5);  // 1.5R
tp2 = entryMid + (risk * 3.0);  // 3.0R

// SHORT
risk = stopLoss - entryMid;
tp1 = entryMid - (risk * 1.5);  // 1.5R
tp2 = entryMid - (risk * 3.0);  // 3.0R
```

**Confidence Calculation:**
```javascript
// From evaluateStrategy() - line 1378
baseConfidence = 60;
biasBonus = htfBias.direction === direction ? (htfBias.confidence * 0.2) : 0;
confidence = Math.min(85, Math.round(baseConfidence + biasBonus));  // 0-100 scale
```

**Strategy Name in JSON:** `SCALP_1H`

---

### 4. MICRO_SCALP Strategy
**Location:** `services/strategy.js` - `evaluateMicroScalp()` (line 1537)

**Timeframes:** 1H → 15m → 5m

**Gatekeepers:**
- 1H trend must NOT be FLAT
- 1H pullback must be ENTRY_ZONE or RETRACING
- **Disregards 4H trend entirely**

**Entry Requirements (LONG):**
- 1H trend = UPTREND
- 15m within ±0.25% of EMA21
- 5m within ±0.25% of EMA21
- 15m pullback = ENTRY_ZONE or RETRACING
- 5m pullback = ENTRY_ZONE or RETRACING
- 15m stoch: oversold (k<25) OR bullish (k<40)
- 5m stoch: oversold (k<25) OR bullish (k<40)

**Entry Requirements (SHORT):**
- Mirror of LONG (inverted)

**Entry Zone Calculation:**
```javascript
// From evaluateMicroScalp() - line ~1650
ema21_15m = tf15m.indicators.ema.ema21;
ema21_5m = tf5m.indicators.ema.ema21;
entryMid = (ema21_15m + ema21_5m) / 2;  // Average of both EMAs

entryZone = {
  min: entryMid * 0.999,  // -0.1%
  max: entryMid * 1.001   // +0.1%
};
```

**Stop Loss Calculation:**
```javascript
// From evaluateMicroScalp() - line ~1680
// LONG
swingLow15m = tf15m.structure.swingLow;
swingLow5m = tf5m.structure.swingLow;
stopLoss = Math.min(swingLow15m, swingLow5m);

// SHORT
swingHigh15m = tf15m.structure.swingHigh;
swingHigh5m = tf5m.structure.swingHigh;
stopLoss = Math.max(swingHigh15m, swingHigh5m);
```

**Targets Calculation:**
```javascript
// From evaluateMicroScalp() - line ~1690
risk = direction === 'long' ? (entryMid - stopLoss) : (stopLoss - entryMid);

// LONG
tp1 = entryMid + (risk * 1.0);  // 1.0R
tp2 = entryMid + (risk * 1.5);  // 1.5R

// SHORT
tp1 = entryMid - (risk * 1.0);  // 1.0R
tp2 = entryMid - (risk * 1.5);  // 1.5R
```

**Confidence Calculation:**
```javascript
// From evaluateMicroScalp() - line ~1700
// Base: 60
// +5-10 for tight confluence (both 15m & 5m within 0.25% of EMA21)
// +5 for stoch alignment
// Range: 60-75%
```

**Strategy Name in JSON:** `MICRO_SCALP`

---

## Backend Evaluation Flow

### Main Entry Point: `evaluateStrategy()`
**File:** `services/strategy.js` (line 1009)

**Parameters:**
- `symbol`: Trading pair (e.g., 'BTCUSDT')
- `multiTimeframeData`: Full timeframe analysis object
- `setupType`: 'Swing' | '4h' | 'Scalp' | 'auto'
- `mode`: 'STANDARD' | 'AGGRESSIVE'

**Priority Order:**
1. **SWING** (if setupType === 'Swing' or 'auto')
2. **TREND_4H** (if setupType === '4h' or 'auto')
3. **SCALP_1H** (if setupType === 'Scalp' or 'auto')
4. **AGGRESSIVE strategies** (if mode === 'AGGRESSIVE' and no valid trade)
5. **NO_TRADE** (if all fail)

**Returns:** Canonical signal structure via `normalizeToCanonical()`

---

### All Strategies Evaluation: `evaluateAllStrategies()`
**File:** `services/strategy.js` (line 1727)

**Purpose:** Evaluate ALL strategies for a symbol/mode, return rich object with all strategies (even NO_TRADE ones)

**Flow:**
1. **SAFE_MODE 4H FLAT Gate:**
   - If `mode === 'STANDARD'` AND `4H === 'FLAT'`:
     - Return all strategies as `NO_TRADE` with reason: "4H trend is FLAT - no trade allowed per SAFE_MODE rules"
     - `bestSignal = null`

2. **Evaluate Each Strategy:**
   - `SWING`: `evaluateStrategy(symbol, data, 'Swing', mode)`
   - `TREND_4H`: `evaluateStrategy(symbol, data, '4h', mode)`
   - `SCALP_1H`: `evaluateStrategy(symbol, data, 'Scalp', mode)`
   - `MICRO_SCALP`: `evaluateMicroScalp(data)` (independent)

3. **Normalize Results:**
   - Each result passed through `normalizeStrategyResult(result, strategyName, mode)`
   - Ensures consistent structure and replaces SAFE blocking reasons in AGGRESSIVE mode

4. **AGGRESSIVE_MODE Forcing Logic:**
   - If `mode === 'AGGRESSIVE'` AND `4H === 'FLAT'`:
     - Check HTF bias (direction + confidence >= 70%)
     - Check 1H/15m trends align with bias
     - **FORCE** at least one strategy (TREND_4H → SCALP_1H → MICRO_SCALP) to `valid = true`
     - Override any previous NO_TRADE states

5. **Select Best Signal:**
   - **SAFE_MODE priority:** TREND_4H → SWING → SCALP_1H → MICRO_SCALP
   - **AGGRESSIVE_MODE priority:** TREND_4H → SCALP_1H → MICRO_SCALP → SWING
   - Fallback to highest confidence if priority doesn't match

**Returns:**
```javascript
{
  strategies: {
    SWING: { valid, direction, confidence, entryZone, stopLoss, targets, ... },
    TREND_4H: { ... },
    SCALP_1H: { ... },
    MICRO_SCALP: { ... }
  },
  bestSignal: "TREND_4H" | null
}
```

---

## Frontend Evaluation Flow

### Main Entry Point: `evaluateTemplateSignal()`
**File:** `public/index.html` (line 1414)

**Parameters:**
- `symbol`: Trading pair
- `templateKey`: '4h' | 'Swing' | 'Scalp' | 'MicroScalp'

**Flow:**
1. **SWING Priority:**
   - If `templateKey === 'Swing'`:
     - Call `evaluateSwingSignalFrontend(symbol, data)`
     - Return immediately (bypasses 4H gate)

2. **4H FLAT Gatekeeper:**
   - Check if 4H trend === 'FLAT'
   - If FLAT: Return `NO_TRADE` with reason: "4H trend is FLAT - no trade allowed per strategy rules"
   - **This blocks Scalp and 4H trades, but NOT Swing (handled above)**

3. **SCALP Gatekeepers:**
   - If `templateKey === 'Scalp'`:
     - Check 1H trend NOT FLAT
     - Check 4H/1H trends aligned (not conflicting)

4. **Template Evaluation:**
   - Check anchor timeframe trends
   - Check confirmation timeframe alignment
   - Calculate confidence (0-1 scale, then converted)
   - Calculate entry zone, stop loss, targets

5. **Return Signal:**
   - Structure matches backend format but may have different field names

**Key Differences from Backend:**
- ❌ Frontend blocks ALL trades (except Swing) when 4H is FLAT
- ❌ Frontend does NOT have AGGRESSIVE_MODE forcing logic
- ❌ Frontend confidence is 0-1 scale (converted to 0-100 for display)
- ❌ Frontend uses different field names (`entryZone` vs `entry_zone`)

---

### Frontend Swing Evaluation: `evaluateSwingSignalFrontend()`
**File:** `public/index.html` (line 654)

**Purpose:** Frontend-specific Swing evaluation (matches backend logic)

**Gatekeepers:**
- 4H trend must NOT be FLAT
- 3D trend must NOT be FLAT
- 1D trend must NOT be FLAT
- 3D pullback = OVEREXTENDED or RETRACING
- 1D pullback = RETRACING or ENTRY_ZONE

**Returns:** Signal object with `valid`, `direction`, `confidence`, `entryZone`, `stopLoss`, `targets`

---

## JSON Output Structure

### API Endpoint: `/api/analyze`
**File:** `api/analyze.js`

**Returns:**
```json
{
  "symbol": "BTCUSDT",
  "price": 91424.5,
  "currentPrice": 91424.5,
  "priceChange24h": 0.65,
  "htfBias": {
    "direction": "long",
    "confidence": 100,
    "source": "1h"
  },
  "timeframes": { ... },
  "signal": {
    "valid": true,
    "direction": "long",
    "confidence": 78,
    "setupType": "4h",
    "selectedStrategy": "TREND_4H",
    "strategiesChecked": ["SWING", "TREND_4H"],
    "entryZone": { "min": 91000, "max": 91200 },
    "stopLoss": 90800,
    "invalidationLevel": 90800,
    "targets": [91800, 92400],
    "riskReward": { "tp1RR": 1.0, "tp2RR": 2.0 },
    "reason": "...",
    "confluence": { ... },
    "conditionsRequired": [ ... ]
  },
  "tradeSignal": { ... },  // Alias for backward compatibility
  "analysis": { ... },
  "microScalpEligible": false,
  "microScalp": null,
  "timestamp": "2025-01-XX..."
}
```

---

### API Endpoint: `/api/analyze-full`
**File:** `api/analyze-full.js`

**Purpose:** Returns rich canonical JSON with ALL strategies (even NO_TRADE ones)

**Returns:**
```json
{
  "symbol": "BTCUSDT",
  "mode": "SAFE" | "AGGRESSIVE",
  "currentPrice": 91424.5,
  "htfBias": {
    "direction": "long",
    "confidence": 100,
    "source": "1h"
  },
  "timeframes": {
    "4h": { "trend": "uptrend", "ema21": 91000, ... },
    "1h": { ... },
    "15m": { ... }
  },
  "strategies": {
    "SWING": {
      "valid": false,
      "direction": "NO_TRADE",
      "confidence": 0,
      "reason": "...",
      "entryZone": null,
      "stopLoss": null,
      "targets": [],
      "riskReward": { "tp1RR": null, "tp2RR": null }
    },
    "TREND_4H": { ... },
    "SCALP_1H": { ... },
    "MICRO_SCALP": { ... }
  },
  "bestSignal": "TREND_4H" | null,
  "schemaVersion": "1.0.0",
  "generatedAt": "2025-01-XX..."
}
```

---

### Frontend JSON Export: `copyAllCoins()`
**File:** `public/index.html` (line ~3600)

**Purpose:** Export all coins/modes to JSON for copying

**Structure:**
```json
{
  "SAFE_MODE": {
    "BTCUSDT": { ... },  // Full rich symbol object from /api/analyze-full
    "ETHUSDT": { ... },
    "SOLUSDT": { ... }
  },
  "AGGRESSIVE_MODE": {
    "BTCUSDT": { ... },
    "ETHUSDT": { ... },
    "SOLUSDT": { ... }
  }
}
```

**Flow:**
1. Fetch from `/api/analyze-full?symbol=XXX&mode=STANDARD` for each symbol
2. Fallback to `buildRichSymbolFromScanResults()` if API fails
3. Fallback to empty structure with all strategies as NO_TRADE if both fail

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    USER INTERACTION                          │
│  - Clicks "SAFE" / "AGGRESSIVE" button                      │
│  - Clicks strategy buttons (4H, Swing, Scalp, M-S)          │
│  - Clicks "COPY ALL" button                                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (index.html)                     │
│                                                              │
│  1. scanMajorCoins()                                         │
│     └─> Calls /api/analyze?symbol=XXX&mode=STANDARD          │
│                                                              │
│  2. evaluateTemplateSignal(symbol, templateKey)             │
│     ├─> SWING: evaluateSwingSignalFrontend()                 │
│     ├─> 4H/SCALP: Checks 4H FLAT gate (blocks if FLAT)       │
│     └─> Returns template signal                              │
│                                                              │
│  3. copyAllCoins()                                           │
│     └─> Calls /api/analyze-full?symbol=XXX&mode=STANDARD     │
│         for each symbol/mode                                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    API ENDPOINTS                             │
│                                                              │
│  /api/analyze                                                │
│  ├─> Fetches multi-timeframe data                           │
│  ├─> Calculates indicators                                   │
│  ├─> Calls strategyService.evaluateStrategy()                │
│  ├─> Calls strategyService.evaluateMicroScalp()              │
│  └─> Returns canonical structure + backward compat fields    │
│                                                              │
│  /api/analyze-full                                           │
│  ├─> Fetches multi-timeframe data                           │
│  ├─> Calculates indicators                                   │
│  ├─> Calls strategyService.evaluateAllStrategies()           │
│  ├─> Builds timeframe summary                                │
│  └─> Returns rich symbol object with ALL strategies          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    STRATEGY ENGINE                           │
│                    (services/strategy.js)                    │
│                                                              │
│  evaluateStrategy()                                          │
│  ├─> Priority 1: SWING (evaluateSwingSetup)                 │
│  ├─> Priority 2: TREND_4H (4H trend play)                    │
│  ├─> Priority 3: SCALP_1H (1H scalp)                        │
│  ├─> Priority 4: AGGRESSIVE strategies (if mode=AGGRESSIVE)  │
│  └─> Priority 5: NO_TRADE                                    │
│                                                              │
│  evaluateAllStrategies()                                     │
│  ├─> SAFE_MODE 4H FLAT gate (blocks all if FLAT)            │
│  ├─> Evaluates all 4 strategies                             │
│  ├─> Normalizes each result                                  │
│  ├─> AGGRESSIVE forcing logic (if mode=AGGRESSIVE & 4H flat)│
│  └─> Selects bestSignal                                      │
│                                                              │
│  evaluateMicroScalp()                                        │
│  └─> Independent LTF mean-reversion system                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Identified Inconsistencies

### 1. **4H FLAT Gatekeeper Logic**

**Backend (`evaluateStrategy`):**
- ✅ SAFE_MODE: Blocks 4H/SCALP when 4H is FLAT
- ✅ AGGRESSIVE_MODE: Allows 4H trend evaluation even when FLAT (uses HTF bias)
- ✅ SWING: Always blocked when 4H is FLAT (separate gatekeeper)

**Backend (`evaluateAllStrategies`):**
- ✅ SAFE_MODE: Blocks ALL strategies when 4H is FLAT (early return)
- ✅ AGGRESSIVE_MODE: Evaluates all strategies, then FORCES valid trades if conditions met

**Frontend (`evaluateTemplateSignal`):**
- ❌ **BLOCKS ALL TRADES** (except Swing) when 4H is FLAT
- ❌ **NO AGGRESSIVE_MODE logic** - frontend doesn't know about AGGRESSIVE mode
- ❌ **Inconsistent with backend** - backend allows AGGRESSIVE trades when 4H is FLAT

**Impact:**
- Frontend shows "NO TRADE" even when backend has valid AGGRESSIVE trades
- User sees different results in UI vs JSON export

**Fix Required:**
- Frontend must check `aggressiveMode` flag
- Frontend must allow AGGRESSIVE trades when 4H is FLAT (if HTF bias + lower TFs align)

---

### 2. **Strategy Evaluation Priority**

**Backend (`evaluateStrategy`):**
- Priority: SWING → TREND_4H → SCALP_1H → AGGRESSIVE → NO_TRADE

**Backend (`evaluateAllStrategies`):**
- SAFE_MODE priority: TREND_4H → SWING → SCALP_1H → MICRO_SCALP
- AGGRESSIVE_MODE priority: TREND_4H → SCALP_1H → MICRO_SCALP → SWING

**Frontend (`evaluateTemplateSignal`):**
- Priority: SWING → (4H gate) → SCALP/4H template evaluation

**Inconsistency:**
- Backend `evaluateStrategy` prioritizes SWING first
- Backend `evaluateAllStrategies` prioritizes TREND_4H first (SAFE_MODE)
- Frontend prioritizes SWING first (matches `evaluateStrategy`)

**Impact:**
- `bestSignal` selection may differ from what user expects
- Frontend template evaluation may not match `bestSignal`

**Fix Required:**
- Standardize priority order across all evaluation paths
- Document priority rules clearly

---

### 3. **Field Name Inconsistencies**

**Backend Returns:**
- `entryZone` (camelCase)
- `stopLoss` (camelCase)
- `invalidationLevel` (camelCase)
- `targets` (array)
- `riskReward.tp1RR` (camelCase)

**Frontend Expects:**
- `entryZone` OR `entry_zone` (both supported)
- `stopLoss` OR `stop_loss` (both supported)
- `invalidationLevel` OR `invalidation_level` (both supported)
- `targets` (array)
- `riskReward.tp1RR` OR `risk_reward.tp1RR` (both supported)

**JSON Export:**
- Uses canonical structure (camelCase from `/api/analyze-full`)

**Impact:**
- Frontend has fallback logic to handle both formats
- No breaking issues, but inconsistent

**Fix Required:**
- Standardize on camelCase everywhere
- Remove snake_case fallbacks (or document as legacy support)

---

### 4. **Confidence Scale Inconsistencies**

**Backend:**
- Returns confidence as 0-100 (integer)

**Frontend:**
- Calculates confidence as 0-1 (decimal)
- Converts to 0-100 for display

**JSON:**
- Uses 0-100 scale (from backend)

**Impact:**
- Frontend template signals may have different confidence than backend
- User sees different confidence values in UI vs JSON

**Fix Required:**
- Standardize on 0-100 scale everywhere
- Frontend should use backend confidence when available

---

### 5. **AGGRESSIVE_MODE Forcing Logic**

**Backend (`evaluateAllStrategies`):**
- ✅ Forces valid trades when:
  - `mode === 'AGGRESSIVE'`
  - `4H === 'FLAT'`
  - `htfBias.confidence >= 70%`
  - `1H/15m trends align with htfBias.direction`
- ✅ Overrides previous NO_TRADE states
- ✅ Sets `bestSignal` to forced strategy

**Frontend:**
- ❌ **NO AGGRESSIVE forcing logic**
- ❌ **Shows NO_TRADE** even when backend has forced trade

**Impact:**
- Frontend UI doesn't reflect AGGRESSIVE trades when 4H is FLAT
- User must check JSON export to see forced trades

**Fix Required:**
- Frontend must check `aggressiveMode` flag
- Frontend must allow AGGRESSIVE trades when 4H is FLAT
- Frontend must display forced trades in UI

---

### 6. **MicroScalp Evaluation**

**Backend:**
- `evaluateMicroScalp()` is **independent** (doesn't check 4H FLAT)
- Returns `{ eligible: boolean, signal: {...} }`

**Frontend:**
- Checks `data.microScalp.valid` from API response
- No independent evaluation

**Inconsistency:**
- Backend evaluates MicroScalp independently
- Frontend only displays if API returned it
- Frontend template evaluation doesn't check MicroScalp

**Impact:**
- MicroScalp may be available but not shown in frontend if API didn't return it
- Frontend template evaluation doesn't match backend MicroScalp logic

**Fix Required:**
- Frontend should evaluate MicroScalp independently (or always use API result)
- Document that MicroScalp is API-only (not frontend template)

---

### 7. **Strategy Name Mapping**

**Backend Strategy Names:**
- `SWING`
- `TREND_4H`
- `SCALP_1H`
- `MICRO_SCALP`

**Frontend Template Keys:**
- `'Swing'`
- `'4h'`
- `'Scalp'`
- `'MicroScalp'`

**Frontend Display Names:**
- `'SWING'`
- `'4 HOUR'`
- `'SCALP'`
- `'MICRO-SCALP'`

**Inconsistency:**
- Backend uses `TREND_4H`, frontend uses `'4h'`
- Backend uses `SCALP_1H`, frontend uses `'Scalp'`
- Mapping logic exists but is scattered

**Impact:**
- Potential mismatches when mapping between backend and frontend
- User confusion about strategy names

**Fix Required:**
- Create centralized strategy name mapping
- Document all name variations

---

### 8. **BestSignal Selection**

**Backend (`evaluateAllStrategies`):**
- SAFE_MODE: TREND_4H → SWING → SCALP_1H → MICRO_SCALP
- AGGRESSIVE_MODE: TREND_4H → SCALP_1H → MICRO_SCALP → SWING
- Fallback: Highest confidence

**Frontend:**
- Uses `bestSignal` from API response
- Falls back to first valid strategy in template evaluation

**Inconsistency:**
- Frontend may select different strategy than backend `bestSignal`
- User-selected strategy (via buttons) overrides `bestSignal`

**Impact:**
- UI may show different strategy than JSON `bestSignal`
- User can manually select strategy, but default may be wrong

**Fix Required:**
- Frontend should always use `bestSignal` from API when available
- User selection should override `bestSignal` only when explicitly chosen

---

## API Endpoints

### `/api/analyze`
**Purpose:** Single strategy evaluation (legacy endpoint)

**Parameters:**
- `symbol`: Trading pair
- `setupType`: 'Swing' | '4h' | 'Scalp' | 'auto' (default: 'auto')
- `mode`: 'STANDARD' | 'AGGRESSIVE' (default: 'STANDARD')

**Returns:** Canonical structure with single `signal` object

**Used By:**
- Frontend `scanMajorCoins()` (initial scan)
- Legacy clients

---

### `/api/analyze-full`
**Purpose:** All strategies evaluation (canonical endpoint)

**Parameters:**
- `symbol`: Trading pair
- `mode`: 'STANDARD' | 'AGGRESSIVE' (default: 'STANDARD')

**Returns:** Rich symbol object with ALL strategies (even NO_TRADE ones)

**Used By:**
- Frontend `copyAllCoins()` (JSON export)
- Frontend `trackThisTrade()` (trade tracking)
- New clients requiring full strategy visibility

---

### `/api/scan`
**Purpose:** Scan all coins for opportunities

**Returns:** Filtered list of opportunities (only valid trades)

**Used By:**
- Scanner service
- Not used by frontend directly

---

## Calculation Formulas Reference

### Entry Zone Formula (All Strategies)
**Function:** `calculateEntryZone(ema21, direction)` - line 537

```javascript
buffer = 0.004;  // 0.4% buffer

// LONG
entryMin = ema21 * 0.996;  // -0.4%
entryMax = ema21 * 1.002;  // +0.2%

// SHORT
entryMin = ema21 * 0.998;  // -0.2%
entryMax = ema21 * 1.004;  // +0.4%
```

**Frontend Fallback (if no entryZone from API):**
```javascript
entryZone = {
  min: ema21 * 0.996,  // -0.4%
  max: ema21 * 1.004    // +0.4%
};
```

---

### Stop Loss Formula (All Strategies)
**Function:** `calculateSLTP(entryPrice, direction, allStructures, setupType, rrTargets)` - line 569

```javascript
buffer = 0.003;  // 0.3% buffer

// Structure selection based on setupType:
// - Swing: 3D or 1D structure
// - Scalp: 5m or 15m structure
// - 4H: 4H structure

// LONG
stopLoss = swingLow ? (swingLow * 0.997) : (entryPrice * 0.97);
invalidationLevel = swingLow || (entryPrice * 0.97);

// SHORT
stopLoss = swingHigh ? (swingHigh * 1.003) : (entryPrice * 1.03);
invalidationLevel = swingHigh || (entryPrice * 1.03);
```

---

### Targets Formula (All Strategies)
**Function:** `calculateSLTP()` - line 569

```javascript
entryMid = (entryZone.min + entryZone.max) / 2;

// LONG
risk = entryMid - stopLoss;
tp1 = entryMid + (risk * rrTargets[0]);
tp2 = entryMid + (risk * rrTargets[1]);

// SHORT
risk = stopLoss - entryMid;
tp1 = entryMid - (risk * rrTargets[0]);
tp2 = entryMid - (risk * rrTargets[1]);
```

**R:R Targets by Strategy:**
- **SWING:** `[3.0, 4.0, 5.0]` (TP3 also calculated)
- **TREND_4H:** `[1.0, 2.0]`
- **SCALP_1H:** `[1.5, 3.0]`
- **MICRO_SCALP:** `[1.0, 1.5]`

---

### Confidence Formula (TREND_4H & SCALP_1H)
**Function:** `calculateConfidence(analysis, direction)` - line 631

```javascript
score = 0;  // 0-1 scale

// 1. 4H trend alignment (0-0.4)
if (direction === 'long' && trend4h === 'UPTREND') score += 0.4;
else if (direction === 'short' && trend4h === 'DOWNTREND') score += 0.4;
else if (trend4h === 'FLAT') score += 0.1;

// 2. 1H confirmation (0-0.2)
if (direction === 'long' && trend1h === 'UPTREND') score += 0.2;
else if (direction === 'short' && trend1h === 'DOWNTREND') score += 0.2;
else if (trend1h === 'FLAT') score += 0.1;

// 3. Stoch alignment (0-0.2)
if (stoch15m.curl === 'up' && stoch5m.curl === 'up') score += 0.2;
else if (stoch15m.curl === 'up' || stoch5m.curl === 'up') score += 0.1;

// 4. Structure confluence (0-0.1)
if (price in good position) score += 0.1;
else score += 0.05;

// 5. MA confluence (0-0.1)
if (pullbackState === 'ENTRY_ZONE') score += 0.1;
else if (pullbackState === 'RETRACING') score += 0.05;

score = Math.min(score, 1.0);  // Cap at 1.0
confidence = Math.round(score * 100);  // Convert to 0-100 scale
```

**SCALP_1H Confidence (Different Formula):**
```javascript
baseConfidence = 60;
biasBonus = htfBias.direction === direction ? (htfBias.confidence * 0.2) : 0;
confidence = Math.min(85, Math.round(baseConfidence + biasBonus));  // 0-100 scale
```

---

### Frontend Template Calculations
**Location:** `public/index.html` - `evaluateTemplateSignal()` - line 1606

**Entry Zone (if not from API):**
```javascript
entryZone = {
  min: ema21 * 0.996,  // -0.4%
  max: ema21 * 1.004    // +0.4%
};
```

**Stop Loss (if not from API):**
```javascript
// Swing: HTF structure (3D/1D)
// Scalp: LTF structure (5m/15m)
// 4H: 4H structure

// LONG
stopLoss = swingLow || (currentPrice * 0.95);

// SHORT
stopLoss = swingHigh || (currentPrice * 1.05);
```

**Targets (if not from API):**
```javascript
entryMid = (entryZone.min + entryZone.max) / 2;
risk = direction === 'long' ? (entryMid - stopLoss) : (stopLoss - entryMid);

// LONG
tp1 = entryMid + (risk * template.rrTargets[0]);
tp2 = entryMid + (risk * template.rrTargets[1]);

// SHORT
tp1 = entryMid - (risk * template.rrTargets[0]);
tp2 = entryMid - (risk * template.rrTargets[1]);
```

**Frontend Confidence:**
```javascript
confidence = 0.3;  // Base

// +0.25 if pullbackState === 'ENTRY_ZONE'
// +0.10 if pullbackState === 'RETRACING'
// +0.15 if confirmsAlign
// +0.10 if stoch aligned
// +0.15 if distanceFrom21 < 0.5%
// +0.08 if distanceFrom21 < 1.5%
// -0.10 if distanceFrom21 > 2.5%

confidence = Math.max(0, Math.min(confidence, 0.95));  // Clamp 0-0.95
confidence = confidence * 100;  // Convert to 0-100 for display
```

---

## Summary of Required Fixes

1. **Frontend AGGRESSIVE_MODE Support:**
   - Add `aggressiveMode` flag check in `evaluateTemplateSignal()`
   - Allow AGGRESSIVE trades when 4H is FLAT (if conditions met)
   - Display forced trades in UI

2. **Standardize Strategy Priority:**
   - Document priority order clearly
   - Ensure frontend matches backend `bestSignal` selection

3. **Field Name Standardization:**
   - Use camelCase everywhere
   - Remove snake_case fallbacks (or document as legacy)

4. **Confidence Scale Standardization:**
   - Use 0-100 scale everywhere
   - Frontend should use backend confidence when available

5. **Strategy Name Mapping:**
   - Create centralized mapping
   - Document all variations

6. **BestSignal Consistency:**
   - Frontend should use `bestSignal` from API
   - User selection should override only when explicit

7. **MicroScalp Evaluation:**
   - Document that MicroScalp is API-only
   - Or add frontend evaluation to match backend

---

## Next Steps

1. Review this audit document
2. Provide specific updates for each inconsistency
3. Implement fixes in priority order
4. Test consistency across all evaluation paths
5. Update documentation

---

**End of Audit Document**

