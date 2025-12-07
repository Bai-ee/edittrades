# Complete Data Reference

**Last Updated:** 2025-01-XX  
**Status:** Production Ready - Complete TradingView-level parity  
**Milestone Tag:** `v1.0-data-parity`

---

## Overview

This document provides a complete reference for all data available in the system. Use this as a definitive guide when developing strategies, adding modules, or troubleshooting data issues.

---

## Complete Timeframe Data Structure

### Full Structure (Per Timeframe)

```javascript
analysis[timeframe] = {
  // === BASIC INDICATORS ===
  indicators: {
    price: {
      current: number,
      high: number,
      low: number
    },
    ema: {
      ema21: number | null,
      ema200: number | null,
      ema21History: number[],
      ema200History: number[]
    },
    stochRSI: {
      k: number | null,        // 0-100 (clamped)
      d: number | null,        // 0-100 (clamped)
      condition: string,       // "BULLISH" | "BEARISH" | "NEUTRAL" | "OVERSOLD" | "OVERBOUGHT"
      history: number[]
    },
    rsi: {
      value: number,           // 0-100
      history: number[],
      overbought: boolean,     // value > 70
      oversold: boolean        // value < 30
    } | null,
    analysis: {
      trend: "UPTREND" | "DOWNTREND" | "FLAT",
      pullbackState: "RETRACING" | "ENTRY_ZONE" | "OVEREXTENDED" | "NEUTRAL",
      distanceFrom21EMA: number  // Percentage
    },
    trendStrength: {
      adx: number | null,
      trend: "UPTREND" | "DOWNTREND" | "FLAT"
    } | null,
    candlestickPatterns: {
      current: string | null,
      bullish: boolean,
      bearish: boolean,
      patterns: Array<{
        name: string,
        bullish: boolean,
        bearish: boolean,
        confidence: number
      }>,
      allPatterns: Array<{...}>
    } | null,
    wickAnalysis: {
      upperWickDominance: number,
      lowerWickDominance: number,
      bodyDominance: number,
      exhaustionSignal: string | null,
      exhaustionSignals: Array<{...}>,
      wickDominance: {...},
      bodyStrength: {...}
    } | null
  },
  
  // === STRUCTURE ===
  structure: {
    swingHigh: number | null,
    swingLow: number | null
  },
  
  // === METADATA ===
  candleCount: number,
  lastCandle: {
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
    timestamp: number
  },
  
  // === ADVANCED MODULES (✅ GUARANTEED TO EXIST) ===
  
  // Market Structure (always object, never null)
  marketStructure: {
    currentStructure: "uptrend" | "downtrend" | "flat" | "unknown",
    lastSwings: Array<{
      type: "HH" | "HL" | "LH" | "LL",
      price: number,
      timestamp: number
    }>,
    lastBos: {
      type: "BOS" | "none",
      direction: "bullish" | "bearish" | "none",
      fromSwing: string | null,
      toSwing: string | null,
      price: number | null,
      timestamp: number | null
    },
    lastChoch: {
      type: "CHOCH" | "none",
      direction: "bullish" | "bearish" | "none",
      fromSwing: string | null,
      toSwing: string | null,
      price: number | null,
      timestamp: number | null
    }
  },
  
  // Volatility (always object with state, never null)
  volatility: {
    atr: number | null,              // Average True Range
    atrPctOfPrice: number | null,    // ATR as % of price
    state: "low" | "normal" | "high" | "extreme"  // Never null
  },
  
  // Volume (always object, never null)
  volume: {
    current: number,                 // Current volume (never null, defaults to 0)
    avg20: number,                   // 20-period average (never null, defaults to 0)
    trend: "up" | "down" | "flat"   // Volume trend
  },
  
  // Volume Profile (always object, never null)
  volumeProfile: {
    highVolumeNodes: Array<{
      price: number,
      volume: number
    }>,                              // Top 3 HVN (empty array if none)
    lowVolumeNodes: Array<{
      price: number,
      volume: number
    }>,                              // Bottom 3 LVN (empty array if none)
    valueAreaHigh: number | null,    // 70% value area high
    valueAreaLow: number | null       // 70% value area low
  },
  
  // Liquidity Zones (always array, never null)
  liquidityZones: Array<{
    type: "equal_highs" | "equal_lows",
    price: number,
    tolerance: number,               // % price difference
    strength: number,                 // 0-100
    side: "buy" | "sell",
    touches: number
  }>,                                // Empty array if none detected
  
  // Fair Value Gaps (always array, never null)
  fairValueGaps: Array<{
    direction: "bullish" | "bearish",
    low: number,
    high: number,
    filled: boolean,
    candleIndex: number
  }>,                                // Empty array if none detected
  
  // Divergences (always array, never null)
  divergences: Array<{
    oscillator: "RSI" | "StochRSI",
    type: "regular" | "hidden",
    side: "bullish" | "bearish",
    pricePointIndex: number,
    oscPointIndex: number
  }>                                 // Empty array if none detected
}
```

---

## Top-Level Rich Symbol Structure

```javascript
{
  symbol: "BTCUSDT",
  mode: "SAFE" | "AGGRESSIVE",
  currentPrice: number,
  
  // HTF Bias
  htfBias: {
    direction: "long" | "short" | "neutral",
    confidence: 0-100,
    source: "4h" | "1d" | "1w" | "none"
  },
  
  // Complete analysis (all timeframes)
  analysis: {
    "1M": { ... },    // Full timeframe data
    "1w": { ... },
    "3d": { ... },
    "1d": { ... },
    "4h": { ... },
    "1h": { ... },
    "15m": { ... },
    "5m": { ... },
    "3m": { ... },
    "1m": { ... }
  },
  
  // Timeframe summary (for export)
  timeframes: {
    "1M": { ... },    // Simplified timeframe data
    "1w": { ... },
    // ... all timeframes
  },
  
  // Strategy results
  strategies: {
    SWING: {
      valid: boolean,
      direction: "LONG" | "SHORT" | "NO_TRADE",
      confidence: 0-100,
      reason: string,
      entryZone: { min: number, max: number },
      stopLoss: number | null,
      invalidationLevel: number | null,
      targets: number[],
      riskReward: { tp1RR: number, tp2RR: number },
      confidenceBreakdown: {
        baseConfidence: number,
        macroLayer: { score: number, multiplier: number },
        primaryLayer: { score: number, multiplier: number },
        executionLayer: { score: number, multiplier: number },
        marketFilters: {...},
        finalConfidence: number
      },
      overrideUsed: boolean,
      overrideNotes: string[]
    },
    TREND_4H: { ... },
    TREND_RIDER: { ... },
    SCALP_1H: { ... },
    MICRO_SCALP: { ... }
  },
  
  bestSignal: "TREND_4H" | "SWING" | ... | null,
  
  // Market data
  marketData: {
    spread: number,
    spreadPercent: number,
    bid: number,
    ask: number,
    bidAskImbalance: number,
    volumeQuality: "HIGH" | "MEDIUM" | "LOW",
    tradeCount24h: number,
    orderBook: {
      bidLiquidity: number | null,
      askLiquidity: number | null,
      imbalance: number | null
    },
    recentTrades: {
      overallFlow: "BULLISH" | "BEARISH" | "NEUTRAL" | "N/A",
      buyPressure: number | null,
      sellPressure: number | null,
      volumeImbalance: number | null
    }
  } | null,
  
  // dFlow prediction market data
  dflowData: {
    symbol: string,
    events: Array<{...}>,
    markets: Array<{...}>
  } | null,
  
  // Metadata
  schemaVersion: "1.0.0",
  jsonVersion: "0.10",
  generatedAt: "ISO timestamp"
}
```

---

## Data Guarantees

### Module Presence Guarantees

| Module | Type | Guarantee | Default if Missing |
|--------|------|-----------|-------------------|
| marketStructure | Object | Always exists | Empty structure with type="none" |
| volatility | Object | Always exists | {atr: null, atrPctOfPrice: null, state: "normal"} |
| volume | Object | Always exists | {current: 0, avg20: 0, trend: "flat"} |
| volumeProfile | Object | Always exists | {highVolumeNodes: [], lowVolumeNodes: [], valueAreaHigh: null, valueAreaLow: null} |
| liquidityZones | Array | Always exists | [] |
| fairValueGaps | Array | Always exists | [] |
| divergences | Array | Always exists | [] |

### Field Guarantees

| Field | Guarantee |
|-------|-----------|
| `volatility.state` | Never null, always one of: "low", "normal", "high", "extreme" |
| `marketStructure.lastBos.type` | Never null, "BOS" or "none" |
| `marketStructure.lastBos.direction` | Matches type: "bullish"/"bearish" if type="BOS", "none" if type="none" |
| `marketStructure.lastChoch.type` | Never null, "CHOCH" or "none" |
| `marketStructure.lastChoch.direction` | Matches type: "bullish"/"bearish" if type="CHOCH", "none" if type="none" |
| `volume.current` | Never null, defaults to 0 |
| `volume.avg20` | Never null, defaults to 0 |
| `volume.trend` | Never null, always "up", "down", or "flat" |
| All arrays | Never null, empty array `[]` if no data |

---

## Using Data in Strategies

### Pattern 1: Market Structure Confirmation

```javascript
const ms = analysis['4h'].marketStructure;

// Check for bullish BOS
if (ms.lastBos.type === 'BOS' && ms.lastBos.direction === 'bullish') {
  // Bullish break of structure
  confidence += 15;
  reason += "Bullish BOS detected. ";
}

// Check current structure
if (ms.currentStructure === 'uptrend') {
  // Favor long trades
  if (direction === 'LONG') {
    confidence += 10;
  }
}
```

### Pattern 2: Volatility-Adjusted Stops

```javascript
const vol = analysis['4h'].volatility;
const entryPrice = analysis['4h'].indicators.price.current;

if (vol.atr) {
  // Use ATR multiplier based on volatility state
  let multiplier = 2.0;
  if (vol.state === 'high' || vol.state === 'extreme') {
    multiplier = 3.0;  // Wider stops in high volatility
  } else if (vol.state === 'low') {
    multiplier = 1.5;  // Tighter stops in low volatility
  }
  
  stopLoss = entryPrice - (vol.atr * multiplier);
}
```

### Pattern 3: Volume Profile Entry Zones

```javascript
const vp = analysis['4h'].volumeProfile;

// Use value area for entry zone
if (vp.valueAreaLow && vp.valueAreaHigh) {
  entryZone = {
    min: vp.valueAreaLow,
    max: vp.valueAreaHigh
  };
}

// Check HVN for support/resistance
const hvn = vp.highVolumeNodes;
const nearestHVN = hvn.find(h => Math.abs(h.price - currentPrice) < 100);
if (nearestHVN) {
  // Price near high volume node
  if (direction === 'LONG' && currentPrice > nearestHVN.price) {
    confidence += 10;  // Price above HVN - bullish
  }
}
```

### Pattern 4: Liquidity Zone Analysis

```javascript
const lz = analysis['4h'].liquidityZones;

// Check for equal highs (resistance)
const equalHighs = lz.filter(z => z.type === 'equal_highs');
if (equalHighs.length > 0) {
  const resistance = equalHighs[0].price;
  if (currentPrice > resistance) {
    // Price broke resistance - bullish
    confidence += 15;
    reason += "Price broke equal highs resistance. ";
  } else if (currentPrice < resistance && currentPrice > resistance * 0.99) {
    // Price near resistance - potential rejection
    confidence -= 10;
    reason += "Price near equal highs resistance. ";
  }
}
```

### Pattern 5: Fair Value Gap Analysis

```javascript
const fvgs = analysis['4h'].fairValueGaps;

// Check for unfilled bullish FVGs
const unfilledBullish = fvgs.filter(f => 
  f.direction === 'bullish' && !f.filled
);
if (unfilledBullish.length > 0) {
  const gap = unfilledBullish[0];
  // Price may fill gap - potential reversal
  if (currentPrice > gap.low && currentPrice < gap.high) {
    // Price in gap - watch for fill
    reason += "Price in unfilled bullish FVG. ";
  }
}
```

### Pattern 6: Divergence Confirmation

```javascript
const divs = analysis['4h'].divergences;

// Check for bullish divergences
const bullishDivs = divs.filter(d => d.side === 'bullish');
if (bullishDivs.length > 0) {
  // Bullish divergence detected
  confidence += 20;
  reason += `Bullish ${bullishDivs[0].oscillator} divergence detected. `;
}

// Check for bearish divergences
const bearishDivs = divs.filter(d => d.side === 'bearish');
if (bearishDivs.length > 0 && direction === 'SHORT') {
  confidence += 20;
  reason += `Bearish ${bearishDivs[0].oscillator} divergence detected. `;
}
```

### Pattern 7: Volume Confirmation

```javascript
const volume = analysis['4h'].volume;

// Check volume trend
if (volume.trend === 'up' && volume.current > volume.avg20) {
  // Increasing volume - confirms trend
  confidence += 10;
  reason += "Volume increasing. ";
}

// Check volume quality (from marketData)
if (marketData && marketData.volumeQuality === 'LOW') {
  // Low volume quality - reduce confidence
  confidence -= 15;
  reason += "Low volume quality. ";
}
```

### Pattern 8: Multi-Module Confluence

```javascript
let confluenceScore = 0;

// Market structure confluence
const ms = analysis['4h'].marketStructure;
if (ms.currentStructure === 'uptrend') confluenceScore += 20;
if (ms.lastBos.type === 'BOS' && ms.lastBos.direction === 'bullish') confluenceScore += 15;

// Volume profile confluence
const vp = analysis['4h'].volumeProfile;
if (vp.valueAreaLow && currentPrice > vp.valueAreaLow) confluenceScore += 10;

// Divergence confluence
const divs = analysis['4h'].divergences;
if (divs.some(d => d.side === 'bullish')) confluenceScore += 15;

// Liquidity zone confluence
const lz = analysis['4h'].liquidityZones;
const equalHighs = lz.filter(z => z.type === 'equal_highs');
if (equalHighs.length > 0 && currentPrice > equalHighs[0].price) confluenceScore += 10;

// Use confluence for confidence
confidence = baseConfidence + confluenceScore;
```

---

## Data Routing for New Analysis

### Adding New Data Source

**Step 1:** Create data fetcher
```javascript
// services/newDataService.js
export async function fetchNewData(symbol) {
  try {
    // Fetch from API
    const data = await fetch(`https://api.example.com/data/${symbol}`);
    return data;
  } catch (error) {
    console.warn('[NewData] Fetch error:', error.message);
    return null;  // Or default structure
  }
}
```

**Step 2:** Add to API endpoint
```javascript
// api/analyze-full.js
import { fetchNewData } from '../services/newDataService.js';

// In main handler
let newData = null;
try {
  newData = await fetchNewData(symbol);
} catch (error) {
  console.warn('[Analyze-Full] New data unavailable:', error.message);
  newData = null;  // Or default structure
}

// Add to richSymbol
const richSymbol = {
  // ... existing fields
  newData: newData || getDefaultNewDataStructure()
};
```

**Step 3:** Add to strategy evaluation
```javascript
// services/strategy.js
export function evaluateAllStrategies(symbol, analysis, mode, marketData, dflowData, newData) {
  // Use newData in strategy evaluation
  if (newData && newData.someField) {
    // Incorporate into confidence calculation
  }
}
```

---

## Troubleshooting Data Issues

### Quick Diagnostic

```bash
# Check all modules present
curl -s "http://localhost:3000/api/analyze-full?symbol=BTCUSDT&mode=STANDARD" | \
  jq '.analysis | to_entries | map({tf: .key, modules: {
    ms: (.value.marketStructure != null),
    vp: (.value.volumeProfile != null),
    vol: (.value.volatility != null),
    lz: (.value.liquidityZones != null),
    fvg: (.value.fairValueGaps != null),
    div: (.value.divergences != null),
    volume: (.value.volume != null)
  }})'
```

### Common Issues

1. **Module is null:** Check validation layer and fallbacks
2. **State is null:** Check classification logic
3. **Array is null:** Check array initialization
4. **Missing in export:** Check frontend export functions

See [Troubleshooting Guide](./TROUBLESHOOTING_GUIDE.md) for detailed solutions.

---

## Related Documentation

- [Data Pipeline Architecture](./DATA_PIPELINE_ARCHITECTURE.md)
- [Strategy Integration Guide](./STRATEGY_INTEGRATION_GUIDE.md)
- [Module Development Guide](./MODULE_DEVELOPMENT_GUIDE.md)
- [Troubleshooting Guide](./TROUBLESHOOTING_GUIDE.md)
