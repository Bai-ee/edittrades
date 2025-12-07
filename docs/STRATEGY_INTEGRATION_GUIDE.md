# Strategy Integration Guide

**Last Updated:** 2025-01-XX  
**Status:** Production Ready  
**Milestone Tag:** `v1.0-data-parity`

---

## Overview

This guide explains how strategies integrate with the data pipeline and how to add new strategies or modify existing ones. The system is designed for smooth integration with all advanced chart analysis modules.

---

## Strategy Evaluation Flow

```
┌─────────────────────────────────────┐
│  Rich Symbol Data                   │
│  - analysis (all timeframes)       │
│  - marketData                       │
│  - dflowData                        │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  evaluateAllStrategies()            │
│  - Evaluates 5 strategies          │
│  - Uses all advanced modules        │
│  - Calculates confidence            │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Strategy Results                   │
│  - SWING                            │
│  - TREND_4H                         │
│  - TREND_RIDER                      │
│  - SCALP_1H                         │
│  - MICRO_SCALP                      │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Confidence Calculation             │
│  - Macro layer                      │
│  - Primary layer                    │
│  - Execution layer                  │
│  - Penalties/bonuses                │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Final Strategy Signals             │
│  - direction                        │
│  - confidence                       │
│  - entryZone                        │
│  - stopLoss                         │
│  - targets                          │
│  - confidenceBreakdown              │
└─────────────────────────────────────┘
```

---

## Available Data for Strategies

### Per Timeframe Data

Each strategy has access to complete timeframe data:

```javascript
analysis[timeframe] = {
  // Basic indicators
  indicators: {
    price: { current, high, low },
    ema: { ema21, ema200, ema21History, ema200History },
    stochRSI: { k, d, condition, history },
    rsi: { value, history, overbought, oversold },
    analysis: { trend, pullbackState, distanceFrom21EMA },
    trendStrength: { adx, trend },
    candlestickPatterns: { ... },
    wickAnalysis: { ... }
  },
  
  // Advanced modules (✅ GUARANTEED TO EXIST)
  marketStructure: {
    currentStructure: "uptrend" | "downtrend" | "flat" | "unknown",
    lastSwings: [{ type, price, timestamp }, ...],
    lastBos: { type, direction, fromSwing, toSwing, price, timestamp },
    lastChoch: { type, direction, fromSwing, toSwing, price, timestamp }
  },
  volatility: {
    atr: number | null,
    atrPctOfPrice: number | null,
    state: "low" | "normal" | "high" | "extreme"  // Never null
  },
  volume: {
    current: number,
    avg20: number,
    trend: "up" | "down" | "flat"
  },
  volumeProfile: {
    highVolumeNodes: [{ price, volume }, ...],
    lowVolumeNodes: [{ price, volume }, ...],
    valueAreaHigh: number | null,
    valueAreaLow: number | null
  },
  liquidityZones: [
    { type: "equal_highs" | "equal_lows", price, strength, touches, side },
    ...
  ],
  fairValueGaps: [
    { direction: "bullish" | "bearish", low, high, filled, candleIndex },
    ...
  ],
  divergences: [
    { oscillator: "RSI" | "StochRSI", type: "regular" | "hidden", side: "bullish" | "bearish", ... },
    ...
  ],
  
  // Metadata
  structure: { swingHigh, swingLow },
  candleCount: number,
  lastCandle: { open, high, low, close, volume, timestamp }
}
```

### Top-Level Data

```javascript
{
  symbol: "BTCUSDT",
  currentPrice: number,
  htfBias: {
    direction: "long" | "short" | "neutral",
    confidence: 0-100,
    source: "4h" | "1d" | ...
  },
  marketData: {
    spread, spreadPercent, bid, ask,
    volumeQuality, tradeCount24h,
    orderBook, recentTrades
  },
  dflowData: {
    events: [...],
    markets: [...]
  }
}
```

---

## Strategy Structure

### Strategy Function Signature

```javascript
function evaluateStrategy(
  symbol,
  analysis,        // All timeframe data
  mode,            // 'STANDARD' | 'AGGRESSIVE'
  marketData,      // Market data (optional)
  dflowData        // dFlow data (optional)
) {
  // Strategy logic here
  return {
    valid: boolean,
    direction: 'LONG' | 'SHORT' | 'NO_TRADE',
    confidence: 0-100,
    reason: string,
    entryZone: { min: number, max: number },
    stopLoss: number | null,
    invalidationLevel: number | null,
    targets: [number, ...],
    riskReward: { tp1RR: number, tp2RR: number },
    confidenceBreakdown: { ... },
    override: boolean,
    overrideUsed: boolean,
    overrideNotes: string[]
  };
}
```

---

## Using Advanced Modules in Strategies

### Market Structure

```javascript
// Check for BOS/CHOCH
const ms = analysis['4h'].marketStructure;
if (ms.lastBos.type === 'BOS' && ms.lastBos.direction === 'bullish') {
  // Bullish break of structure detected
  confidence += 10;
}

// Check current structure
if (ms.currentStructure === 'uptrend') {
  // Favor long trades
}
```

### Volatility

```javascript
// Use ATR for stop loss sizing
const vol = analysis['4h'].volatility;
if (vol.atr) {
  stopLoss = entryPrice - (vol.atr * 2);  // 2x ATR stop
}

// Filter by volatility state
if (vol.state === 'extreme') {
  // Reduce position size or skip trade
  confidence -= 20;
}
```

### Volume Profile

```javascript
// Use value area for entry zones
const vp = analysis['4h'].volumeProfile;
if (vp.valueAreaLow && vp.valueAreaHigh) {
  entryZone = {
    min: vp.valueAreaLow,
    max: vp.valueAreaHigh
  };
}

// Check HVN for support/resistance
const hvn = vp.highVolumeNodes;
const nearestHVN = findNearestHVN(currentPrice, hvn);
if (priceNearHVN(currentPrice, nearestHVN)) {
  // Price at high volume node - potential reversal
}
```

### Liquidity Zones

```javascript
// Check for equal highs/lows
const lz = analysis['4h'].liquidityZones;
const equalHighs = lz.filter(z => z.type === 'equal_highs');
if (equalHighs.length > 0) {
  // Potential resistance zone
  const resistance = equalHighs[0].price;
  if (currentPrice > resistance) {
    // Price broke resistance - bullish
    confidence += 15;
  }
}
```

### Fair Value Gaps

```javascript
// Check for unfilled FVGs
const fvgs = analysis['4h'].fairValueGaps;
const unfilledBullish = fvgs.filter(f => 
  f.direction === 'bullish' && !f.filled
);
if (unfilledBullish.length > 0) {
  // Price may fill gap - potential reversal
  const gap = unfilledBullish[0];
  if (currentPrice > gap.low && currentPrice < gap.high) {
    // Price in gap - watch for fill
  }
}
```

### Divergences

```javascript
// Check for bullish/bearish divergences
const divs = analysis['4h'].divergences;
const bullishDivs = divs.filter(d => d.side === 'bullish');
if (bullishDivs.length > 0) {
  // Bullish divergence detected
  confidence += 20;
  reason += "Bullish RSI divergence detected. ";
}
```

### Volume Analysis

```javascript
// Check volume trend
const vol = analysis['4h'].volume;
if (vol.trend === 'up' && vol.current > vol.avg20) {
  // Increasing volume - confirms trend
  confidence += 10;
}

// Filter by volume quality
if (marketData && marketData.volumeQuality === 'LOW') {
  // Low volume quality - reduce confidence
  confidence -= 15;
}
```

---

## Confidence Calculation

### Hierarchical Confidence System

```javascript
const confidenceBreakdown = {
  baseConfidence: 50,
  
  macroLayer: {
    score: 0-100,
    multiplier: 1.0-2.0,
    factors: {
      htfBias: { direction, confidence },
      marketStructure: { currentStructure, lastBos, lastChoch },
      volatility: { state, atrPct }
    }
  },
  
  primaryLayer: {
    score: 0-100,
    multiplier: 1.0-1.5,
    factors: {
      trend: { direction, strength },
      emaAlignment: { priceAbove21, ema21Above200 },
      pullbackState: { state, distanceFrom21EMA }
    }
  },
  
  executionLayer: {
    score: 0-100,
    multiplier: 1.0-1.3,
    factors: {
      stochRSI: { k, d, state },
      rsi: { value, overbought, oversold },
      candlestickPatterns: { current, confidence },
      wickAnalysis: { exhaustionSignal }
    }
  },
  
  marketFilters: {
    volumeQuality: { passed: boolean, note: string },
    tradeFlow: { passed: boolean, note: string },
    dflowAlignment: { passed: boolean, note: string }
  },
  
  penaltiesApplied: [],
  capsApplied: [],
  
  finalConfidence: 0-100
};
```

### Using Confidence Breakdown

```javascript
// In strategy evaluation
const confidence = calculateConfidenceWithHierarchy(
  analysis,
  mode,
  marketData,
  dflowData
);

// Access breakdown for detailed explanation
const breakdown = confidence.breakdown;
console.log(`Macro layer: ${breakdown.macroLayer.score} (${breakdown.macroLayer.multiplier}x)`);
console.log(`Primary layer: ${breakdown.primaryLayer.score} (${breakdown.primaryLayer.multiplier}x)`);
console.log(`Execution layer: ${breakdown.executionLayer.score} (${breakdown.executionLayer.multiplier}x)`);
```

---

## Adding a New Strategy

### Step 1: Create Strategy Function

**Location:** `services/strategy.js`

```javascript
function evaluateNewStrategy(symbol, analysis, mode, marketData, dflowData) {
  // Get required timeframe data
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  
  // Check prerequisites
  if (!tf4h || !tf4h.indicators) {
    return getNoTradeResult('Insufficient 4h data');
  }
  
  // Use advanced modules
  const ms = tf4h.marketStructure;  // Guaranteed to exist
  const vol = tf4h.volatility;       // Guaranteed to exist
  const vp = tf4h.volumeProfile;   // Guaranteed to exist
  
  // Strategy logic
  let valid = false;
  let direction = 'NO_TRADE';
  let confidence = 0;
  let reason = '';
  
  // Example: Use market structure
  if (ms.currentStructure === 'uptrend' && ms.lastBos.type === 'BOS') {
    valid = true;
    direction = 'LONG';
    confidence = 60;
    reason = 'Uptrend with bullish BOS';
  }
  
  // Use volatility for stop loss
  let stopLoss = null;
  if (vol.atr && valid) {
    const entryPrice = tf4h.indicators.price.current;
    stopLoss = entryPrice - (vol.atr * 2);
  }
  
  // Use volume profile for entry zone
  let entryZone = { min: null, max: null };
  if (vp.valueAreaLow && vp.valueAreaHigh && valid) {
    entryZone = {
      min: vp.valueAreaLow,
      max: vp.valueAreaHigh
    };
  }
  
  // Calculate targets
  const targets = calculateTargets(entryZone, stopLoss);
  
  // Return normalized result
  return normalizeStrategyResult({
    valid,
    direction,
    confidence,
    reason,
    entryZone,
    stopLoss,
    targets,
    // ... other fields
  });
}
```

### Step 2: Add to evaluateAllStrategies

**Location:** `services/strategy.js` - `evaluateAllStrategies()`

```javascript
export function evaluateAllStrategies(symbol, analysis, mode, marketData, dflowData) {
  const strategies = {
    SWING: null,
    TREND_4H: null,
    TREND_RIDER: null,
    SCALP_1H: null,
    MICRO_SCALP: null,
    NEW_STRATEGY: null  // Add new strategy
  };
  
  // ... existing strategies
  
  // Add new strategy evaluation
  try {
    strategies.NEW_STRATEGY = evaluateNewStrategy(
      symbol, analysis, mode, marketData, dflowData
    );
  } catch (error) {
    console.error(`[Strategy] Error evaluating NEW_STRATEGY:`, error);
    strategies.NEW_STRATEGY = getNoTradeResult('Strategy evaluation error');
  }
  
  // ... rest of function
}
```

### Step 3: Update Strategy Names/Keys

**Location:** `public/index.html` (if needed for UI)

```javascript
const strategyOptions = ['4h', 'Swing', 'TrendRider', 'Scalp', 'MicroScalp', 'NewStrategy'];
const strategyMap = {
  '4h': 'TREND_4H',
  'Swing': 'SWING',
  'TrendRider': 'TREND_RIDER',
  'Scalp': 'SCALP_1H',
  'MicroScalp': 'MICRO_SCALP',
  'NewStrategy': 'NEW_STRATEGY'  // Add mapping
};
```

---

## Strategy Mode Integration

### STANDARD vs AGGRESSIVE

**Location:** `services/strategy.js` - `THRESHOLDS` object

```javascript
const THRESHOLDS = {
  STANDARD: {
    emaPullbackMax: 1.0,
    minHtfBiasConfidence: 60,
    minConfidence: 70,
    // ... other thresholds
  },
  AGGRESSIVE: {
    emaPullbackMax: 1.75,
    minHtfBiasConfidence: 40,
    minConfidence: 50,
    // ... other thresholds
  }
};
```

### Using Mode in Strategy

```javascript
function evaluateStrategy(symbol, analysis, mode, ...) {
  const thresholds = THRESHOLDS[mode];
  
  // Use mode-specific thresholds
  if (confidence < thresholds.minConfidence) {
    return getNoTradeResult('Confidence below threshold');
  }
  
  // Mode-specific logic
  if (mode === 'AGGRESSIVE') {
    // Allow looser requirements
    emaPullbackMax = thresholds.emaPullbackMax;
  }
}
```

---

## Market Data Integration

### Using Market Data Filters

```javascript
// Volume quality filter
if (marketData && marketData.volumeQuality === 'LOW') {
  confidence -= 20;
  reason += 'Low volume quality. ';
}

// Trade flow filter
if (marketData && marketData.recentTrades) {
  const flow = marketData.recentTrades.overallFlow;
  if (flow === 'BEARISH' && direction === 'LONG') {
    confidence -= 15;
    reason += 'Bearish trade flow. ';
  }
}

// Spread filter
if (marketData && marketData.spreadPercent > 0.1) {
  confidence -= 10;
  reason += 'Wide spread. ';
}
```

### Using dFlow Data

```javascript
// Check dFlow alignment
if (dflowData && dflowData.markets) {
  const aligned = checkDflowAlignment(direction, dflowData);
  if (!aligned) {
    confidence -= 10;
    reason += 'dFlow prediction misaligned. ';
  }
}
```

---

## Best Practices

### 1. Always Check Module Existence

```javascript
// ✅ CORRECT - Modules guaranteed to exist
const ms = analysis['4h'].marketStructure;  // Always exists
if (ms.lastBos.type === 'BOS') {
  // Use it
}

// ❌ WRONG - Don't check for null
if (analysis['4h'].marketStructure) {  // Unnecessary
  // ...
}
```

### 2. Use Structured Data Safely

```javascript
// ✅ CORRECT - Arrays always exist
const fvgs = analysis['4h'].fairValueGaps;  // Always array
fvgs.forEach(fvg => {
  // Process FVG
});

// ❌ WRONG - Don't check for null
if (analysis['4h'].fairValueGaps) {  // Unnecessary
  // ...
}
```

### 3. Handle Optional Fields

```javascript
// ✅ CORRECT - Check optional fields
const vp = analysis['4h'].volumeProfile;  // Always exists
if (vp.valueAreaHigh && vp.valueAreaLow) {
  // Use value area
}

// ✅ CORRECT - Check array length
const lz = analysis['4h'].liquidityZones;  // Always array
if (lz.length > 0) {
  // Process zones
}
```

### 4. Use Confidence Breakdown

```javascript
// ✅ CORRECT - Use detailed breakdown
const result = calculateConfidenceWithHierarchy(...);
const breakdown = result.breakdown;

// Explain confidence
reason += `Macro: ${breakdown.macroLayer.score}, `;
reason += `Primary: ${breakdown.primaryLayer.score}, `;
reason += `Execution: ${breakdown.executionLayer.score}`;
```

### 5. Normalize Strategy Results

```javascript
// ✅ CORRECT - Use normalizeStrategyResult
return normalizeStrategyResult({
  valid,
  direction,
  confidence,
  reason,
  entryZone,
  stopLoss,
  targets,
  // ... other fields
});

// This ensures consistent structure and includes:
// - confidenceBreakdown
// - overrideUsed
// - overrideNotes
// - riskReward
```

---

## Testing Strategies

### Unit Test Template

```javascript
// Test strategy with mock data
const mockAnalysis = {
  '4h': {
    indicators: { ... },
    marketStructure: { ... },
    volatility: { ... },
    // ... all modules
  }
};

const result = evaluateNewStrategy(
  'BTCUSDT',
  mockAnalysis,
  'STANDARD',
  null,
  null
);

// Assertions
assert(result.valid === true);
assert(result.direction === 'LONG' || result.direction === 'SHORT');
assert(result.confidence >= 0 && result.confidence <= 100);
assert(result.entryZone.min < result.entryZone.max);
assert(result.stopLoss !== null);
assert(result.targets.length > 0);
```

### Integration Test

```bash
# Test strategy via API
curl "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.strategies.NEW_STRATEGY'
```

---

## Common Patterns

### Pattern 1: Multi-Timeframe Confirmation

```javascript
const tf4h = analysis['4h'];
const tf1h = analysis['1h'];
const tf15m = analysis['15m'];

// Require alignment across timeframes
if (tf4h.indicators.analysis.trend === 'UPTREND' &&
    tf1h.indicators.analysis.trend === 'UPTREND' &&
    tf15m.indicators.analysis.trend === 'UPTREND') {
  // All timeframes aligned - high confidence
  confidence += 20;
}
```

### Pattern 2: Confluence Scoring

```javascript
let confluenceScore = 0;

// Market structure confluence
if (ms.currentStructure === 'uptrend') confluenceScore += 20;
if (ms.lastBos.type === 'BOS') confluenceScore += 15;

// Volume profile confluence
if (vp.valueAreaLow && currentPrice > vp.valueAreaLow) confluenceScore += 10;

// Divergence confluence
if (divs.some(d => d.side === 'bullish')) confluenceScore += 15;

// Use confluence for confidence
confidence = baseConfidence + confluenceScore;
```

### Pattern 3: Volatility-Adjusted Stops

```javascript
const vol = analysis['4h'].volatility;
const entryPrice = analysis['4h'].indicators.price.current;

if (vol.atr) {
  // Use ATR multiplier based on volatility state
  let atrMultiplier = 2.0;  // Default
  
  if (vol.state === 'high' || vol.state === 'extreme') {
    atrMultiplier = 3.0;  // Wider stops in high volatility
  } else if (vol.state === 'low') {
    atrMultiplier = 1.5;  // Tighter stops in low volatility
  }
  
  stopLoss = entryPrice - (vol.atr * atrMultiplier);
}
```

---

## Troubleshooting Strategy Issues

### Issue: Strategy Always Returns NO_TRADE

**Check:**
1. Prerequisites met (trend, EMAs, etc.)
2. Confidence above threshold
3. Market filters passing
4. Mode-specific requirements

**Debug:**
```javascript
console.log('[Strategy] Prerequisites:', {
  trend: tf4h.indicators.analysis.trend,
  ema21: tf4h.indicators.ema.ema21,
  confidence: calculatedConfidence
});
```

### Issue: Confidence Too Low

**Check:**
1. Confidence breakdown scores
2. Penalties applied
3. Mode thresholds
4. Market filter impacts

**Debug:**
```javascript
const breakdown = confidence.breakdown;
console.log('[Strategy] Confidence breakdown:', breakdown);
console.log('[Strategy] Penalties:', breakdown.penaltiesApplied);
```

### Issue: Entry Zone/Stop Loss Invalid

**Check:**
1. Volume profile data exists
2. ATR calculated
3. Price data valid
4. Calculations correct

**Debug:**
```javascript
console.log('[Strategy] Entry calculation:', {
  vp: tf4h.volumeProfile,
  vol: tf4h.volatility,
  price: tf4h.indicators.price.current
});
```

---

## Related Documentation

- [Data Pipeline Architecture](./DATA_PIPELINE_ARCHITECTURE.md)
- [Troubleshooting Guide](./TROUBLESHOOTING_GUIDE.md)
- [Module Development Guide](./MODULE_DEVELOPMENT_GUIDE.md)
- [Strategy Modes](./STRATEGY_MODES.md)
