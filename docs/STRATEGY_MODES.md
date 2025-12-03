# Strategy Modes: STANDARD vs AGGRESSIVE

Complete reference for STANDARD and AGGRESSIVE trading modes.

**Last Updated:** 2025-01-XX  
**Implementation:** `services/strategy.js`

---

## Overview

The system supports two trading modes with different risk profiles and trade frequency:

- **STANDARD Mode:** Conservative, high-probability setups only
- **AGGRESSIVE Mode:** Looser requirements for more trade opportunities (smaller position sizes)

---

## Mode Configuration

### THRESHOLDS Object

**Location:** `services/strategy.js` line ~198

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
    microScalpEmaBand: 0.75,    // Wider EMA band
    allowFlat4HForScalp: true, // Allow scalps when 4H is FLAT
    minHtfBiasConfidence: 40    // Lower confidence threshold
  }
};
```

---

## STANDARD Mode

### Characteristics

- **Risk Profile:** Medium to high confidence trades
- **Position Size:** Standard (1% risk per trade)
- **Trade Frequency:** Lower (only high-quality setups)
- **4H Gate:** Hard block when 4H is FLAT (for most strategies)

### Strategy Behavior

#### SWING Strategy
- ✅ Requires 4H NOT FLAT
- ✅ Requires 3D NOT FLAT
- ✅ Requires 1D NOT FLAT
- ✅ Strict pullback requirements
- **Unchanged in AGGRESSIVE mode**

#### TREND_4H Strategy
- ✅ Requires 4H NOT FLAT (hard block in STANDARD, unless override)
- ✅ **Override Available:** When HTF bias >= 60%, 1H/15m trends align, momentum confirms
- ✅ Requires 1H confirmation
- ✅ Price within 1.0% of 4H EMA21
- ✅ Stoch alignment required

#### TREND_RIDER Strategy
- ✅ Requires HTF bias confidence ≥ 65% (STANDARD) or ≥ 55% (AGGRESSIVE)
- ✅ Requires 4H/1H trend alignment
- ✅ Can use HTF bias when 4H is FLAT (AGGRESSIVE mode)
- ✅ Price above/below 4H & 1H 21/200 EMAs
- ✅ Shallow pullbacks allowed (RETRACING/ENTRY_ZONE)
- ✅ 15m/5m Stoch alignment required

#### SCALP_1H Strategy
- ✅ Requires 1H NOT FLAT
- ❌ Blocked when 4H is FLAT (unless HTF bias strong)
- ✅ Price within 2% of 1H EMA21
- ✅ 15m pullback required

#### MICRO_SCALP Strategy
- ✅ Requires 1H NOT FLAT
- ✅ 15m/5m within ±0.25% of EMA21
- ✅ Both 15m and 5m stoch aligned
- ✅ Very tight confluence required

### Confidence Scoring

**Hierarchical System Caps (STANDARD):**

| Condition | Max Confidence |
|-----------|----------------|
| ANY macro contradiction | 75% |
| 4H contradiction | 65% |
| 1D + 4H contradiction | 55% |
| 1D opposite + exhaustion | 45% |

---

## AGGRESSIVE Mode

### Characteristics

- **Risk Profile:** Lower confidence trades accepted
- **Position Size:** Reduced (0.5% for scalps, 0.33% for micro-scalp)
- **Trade Frequency:** Higher (more opportunities)
- **4H Gate:** Soft (can use HTF bias when 4H is FLAT)

### Strategy Behavior

#### SWING Strategy
- ✅ **Unchanged** - Still requires 4H NOT FLAT
- ✅ Same strict requirements
- **No AGGRESSIVE variant**

#### TREND_4H Strategy
- ⚠️ Can use HTF bias when 4H is FLAT (if confidence ≥ 70%)
- ✅ Wider pullback zone (1.75% vs 1.0%)
- ✅ Looser stoch requirements
- ✅ Uses `effectiveTrend4h` (HTF bias + 4H trend)

#### TREND_RIDER Strategy
- ✅ Can use HTF bias when 4H is FLAT (if confidence ≥ 55%)
- ✅ Wider 4H overextension tolerance (4.5% vs 3.0%)
- ✅ Entry zone slightly widened (1.0015x factor)
- ✅ Earlier entries in trends (shallow pullbacks)

#### SCALP_1H Strategy (AGGRO_SCALP_1H)
- ✅ **Allows 1H FLAT trend** (not just UP/DOWN)
- ✅ Wider pullback zone: ±2.5% from EMA21
- ✅ Looser stoch: k < 75 for longs (not just overbought)
- ✅ **Half position size:** 0.5% risk vs 1% standard
- ✅ Counter-trend fades allowed

#### MICRO_SCALP Strategy (AGGRO_MICRO_SCALP)
- ✅ Wider EMA band: ±0.75% vs ±0.25%
- ✅ Only needs ONE stoch oversold/overbought (not both)
- ✅ **1/3 position size:** 0.33% risk
- ✅ Very tight stops

### Confidence Scoring

**Hierarchical System Caps (AGGRESSIVE):**

| Condition | Max Confidence |
|-----------|----------------|
| ANY macro contradiction | 80% |
| 4H contradiction | 70% |
| 1D + 4H contradiction | 60% |
| 1D opposite + exhaustion | 50% |

**Note:** Caps are 5% higher than STANDARD mode.

---

## Mode Selection Flow

### User Selection

1. User clicks "STANDARD" / "AGGRESSIVE" button in UI
2. Frontend sends `?mode=AGGRESSIVE` query param
3. Backend evaluates strategies with AGGRESSIVE thresholds
4. If conservative strategies find trade → use it (normal risk)
5. If NO conservative trade → try aggressive strategies (half/third risk)
6. Return trade with `aggressiveUsed: true` flag (if applicable)

### Backend Evaluation

**In `evaluateAllStrategies()`:**

```javascript
// STANDARD Mode 4H FLAT Override Logic
if (mode === 'STANDARD' && is4HFlat) {
  // Check if override conditions are met:
  const biasStrong = htfBias && htfBias.confidence >= 60;
  const trend1hMatches = isSameDirection(trend1h, htfBias.direction);
  const trend15mMatches = isSameDirection(trend15m, htfBias.direction);
  const momentumOK = (htfBias.direction === 'long' && stoch1h.k < 60) ||
                     (htfBias.direction === 'short' && stoch1h.k > 40);
  
  if (biasStrong && trend1hMatches && trend15mMatches && momentumOK) {
    // Allow override - set overrideUsed flag
    overrideUsed = true;
    overrideNotes = [
      'SAFE override: HTF bias + 1H/15m trend alignment',
      `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`,
      // ... more notes
    ];
    // Continue with strategy evaluation
  } else {
    // No override - return all strategies as NO_TRADE
    return { strategies: { all NO_TRADE }, bestSignal: null };
  }
}

// AGGRESSIVE Mode Forcing Logic
if (mode === 'AGGRESSIVE' && is4HFlat) {
  // Check HTF bias (direction + confidence >= 60%)
  // Check 1H/15m trends align with bias
  // FORCE at least one strategy to valid = true
  if (htfBias.confidence >= 60 && htfBias.direction !== 'neutral') {
    // Force strategies with override flag
    // ...
  }
}
```

---

## Strategy Priority by Mode

### STANDARD Mode Priority

1. **TREND_4H** (if 4H trending)
2. **TREND_RIDER** (if HTF bias + 4H/1H aligned)
3. **SWING** (if 3D/1D/4H structure)
4. **SCALP_1H** (if 1H trending)
5. **MICRO_SCALP** (if LTF confluence)

### AGGRESSIVE Mode Priority

1. **TREND_RIDER** (if HTF bias + 4H/1H aligned)
2. **TREND_4H** (can use HTF bias)
3. **SCALP_1H** (looser requirements)
4. **MICRO_SCALP** (wider bands)
5. **SWING** (unchanged)

---

## Example Scenarios

### Scenario 1: 4H FLAT, 1H UPTREND

**STANDARD Mode:**
- ⚠️ TREND_4H: Blocked (4H FLAT) **UNLESS override conditions met**
  - Override requires: HTF bias >= 60%, 1H/15m trends align, momentum confirms
- ❌ SWING: Blocked (4H FLAT, no override)
- ⚠️ SCALP_1H: May work if HTF bias strong
- ✅ MICRO_SCALP: Works if LTF confluence tight

**AGGRESSIVE Mode:**
- ✅ TREND_4H: May work (uses HTF bias)
- ❌ SWING: Still blocked (4H FLAT)
- ✅ SCALP_1H: Works (AGGRO_SCALP_1H)
- ✅ MICRO_SCALP: Works (AGGRO_MICRO_SCALP, wider bands)

### Scenario 2: 4H UPTREND, 1H UPTREND

**STANDARD Mode:**
- ✅ TREND_4H: Works (high confidence)
- ✅ SWING: May work (if 3D/1D structure)
- ✅ SCALP_1H: Works (if 15m pullback)
- ✅ MICRO_SCALP: Works (if LTF confluence)

**AGGRESSIVE Mode:**
- ✅ TREND_4H: Works (same as STANDARD)
- ✅ SWING: Works (same as STANDARD)
- ✅ SCALP_1H: Works (same as STANDARD)
- ✅ MICRO_SCALP: Works (same as STANDARD)

**Result:** Both modes find trades, STANDARD takes priority.

---

## Position Sizing

### STANDARD Mode

- **TREND_4H:** 1% risk per trade
- **SWING:** 1% risk per trade
- **SCALP_1H:** 1% risk per trade
- **MICRO_SCALP:** 1% risk per trade

### AGGRESSIVE Mode

- **TREND_4H:** 1% risk per trade (unchanged)
- **SWING:** 1% risk per trade (unchanged)
- **AGGRO_SCALP_1H:** 0.5% risk per trade (half size)
- **AGGRO_MICRO_SCALP:** 0.33% risk per trade (third size)

**Rationale:** Lower confidence trades = smaller position sizes

---

## When to Use Each Mode

### Use STANDARD Mode When:

- ✅ You want only high-probability setups
- ✅ You prefer fewer, higher-quality trades
- ✅ You're comfortable with lower trade frequency
- ✅ You want maximum confidence in signals

### Use AGGRESSIVE Mode When:

- ✅ Market is choppy (4H FLAT)
- ✅ You want more trading opportunities
- ✅ You're comfortable with lower confidence trades
- ✅ You can manage smaller position sizes
- ✅ You want to trade during consolidation periods

---

## Mode-Specific Strategy Variants

### AGGRO_SCALP_1H

**Differences from SCALP_1H:**
- Allows 1H FLAT trend
- Wider pullback zone (±2.5% vs ±2%)
- Looser stoch requirements
- Half position size (0.5% vs 1%)
- Counter-trend fades allowed

**When Used:**
- Mode = AGGRESSIVE
- 4H is FLAT
- 1H is FLAT or trending
- HTF bias provides direction

### AGGRO_MICRO_SCALP

**Differences from MICRO_SCALP:**
- Wider EMA band (±0.75% vs ±0.25%)
- Only needs ONE stoch oversold/overbought
- Third position size (0.33% vs 1%)
- Very tight stops

**When Used:**
- Mode = AGGRESSIVE
- 1H trending
- LTF confluence less tight than STANDARD requirements

---

## API Usage

### Request

```javascript
// STANDARD mode (default)
GET /api/analyze?symbol=BTCUSDT&mode=STANDARD

// AGGRESSIVE mode
GET /api/analyze?symbol=BTCUSDT&mode=AGGRESSIVE
```

### Response

```json
{
  "symbol": "BTCUSDT",
  "mode": "STANDARD" | "AGGRESSIVE",
  "strategies": {
    "TREND_4H": { /* ... */ },
    "SCALP_1H": { /* ... */ },
    // ... all strategies
  },
  "bestSignal": "TREND_4H" | null
}
```

---

## Frontend Integration

### Mode Toggle

**Location:** `public/index.html`

```javascript
// Toggle button
<button onclick="toggleAggressiveMode()">
  {aggressiveMode ? 'AGGRESSIVE' : 'STANDARD'}
</button>

// State management
let aggressiveMode = localStorage.getItem('aggressiveMode') === 'true';

// API calls
const mode = aggressiveMode ? 'AGGRESSIVE' : 'STANDARD';
const response = await fetch(`/api/analyze?symbol=${symbol}&mode=${mode}`);
```

---

## Best Practices

1. **Start with STANDARD:** Use STANDARD mode initially to understand system
2. **Monitor Performance:** Track win rate and R multiples by mode
3. **Adjust Position Sizes:** AGGRESSIVE mode uses smaller sizes for a reason
4. **Understand Context:** AGGRESSIVE trades have lower confidence - trade accordingly
5. **Use HTF Bias:** AGGRESSIVE mode relies more on HTF bias - understand it

---

## Related Documentation

- `STRATEGY_IMPLEMENTATION_GUIDE.md` - Complete strategy reference
- `STRATEGY_ARCHITECTURE.md` - System architecture
- `ADDING_STRATEGIES.md` - Guide for adding new strategies

---

**Last Updated:** 2025-01-XX  
**Version:** 1.0.0

