# AI System Documentation

Complete reference for all AI analysis components in the EditTrades system.

**Last Updated:** 2025-01-27  
**Version:** 2.0.0

---

## Table of Contents

1. [Overview](#overview)
2. [Complete Feature Breakdown](#complete-feature-breakdown)
3. [AI Components](#ai-components)
4. [Frontend Integration Guide](#frontend-integration-guide)
5. [API Endpoint](#api-endpoint)
6. [LLM Configuration](#llm-configuration)
7. [System Prompts](#system-prompts)
8. [Enhancement Guide](#enhancement-guide)
9. [Troubleshooting](#troubleshooting)

---

## Overview

The EditTrades system uses **OpenAI's GPT-4o-mini** model to provide AI-powered trade analysis across multiple interfaces. All AI analysis flows through a single API endpoint (`/api/agent-review`) with different prompts and data structures depending on the use case.

### AI Interfaces

1. **Marquee AI** - Market-wide sentiment analysis (scrolling banner)
2. **Details Section AI** - Individual trade call analysis (per symbol)
3. **Trade Tracker AI** - Active position analysis (per tracked trade)
4. **Market Pulse Intelligence** - Adaptive context-aware market analysis

---

## Complete Feature Breakdown

### 1. Tone Interpolation Module (Reusable Globally)

**Purpose:** Centralized tone weighting system used across all AI interfaces to determine appropriate tone based on market conditions.

**Location:** `public/index.html` (lines ~2577-2800), `public/tracker.html` (included for tracker)

**Key Functions:**
- `getInterpolatedTone({ riskScore, trendScore, signalScore, overrideTone, allowOverride })`
- `calculateToneScores(data, symbol)`
- `calculateDynamicToneWeight(data, symbol, overrideTone)`

**How It Works:**
1. Extracts scores from market data (risk, trend, signals)
2. Calculates weighted scores for cautionary, optimistic, and neutral tones
3. Determines final tone based on highest score (>0.5 threshold)
4. Returns soft tone hints for gradual blending

**Scoring System:**
- **Risk Profile (0-0.3):** User risk-off setting adds to cautionary
- **HTF Bias/Trend (0-0.4):** Short bias → cautionary, Long bias → optimistic
- **Trend Alignment (0-0.3):** 60%+ bearish/bullish timeframes
- **Signal Count (0-0.2):** 0 signals → cautionary, 2+ signals → optimistic

**Usage Across Interfaces:**
- **Marquee AI:** Aggregates scores across all symbols (BTC, ETH, SOL)
- **Details AI:** Uses symbol-specific scores
- **Trade Tracker AI:** Uses trade-specific scores
- **Market Pulse:** Uses symbol-specific scores

**Frontend Integration:**
```javascript
// Example usage in any AI function
const scores = calculateToneScores(data, symbol);
const toneResult = getInterpolatedTone({
  riskScore: scores.riskScore,
  trendScore: scores.trendScore,
  signalScore: scores.signalScore,
  overrideTone: null,  // Can override manually
  allowOverride: true
});

// toneResult contains:
// - finalTone: 'neutral' | 'optimistic' | 'cautionary' | 'assertive'
// - weight: 0-1 (confidence in tone)
// - softToneHints: { primary, secondary, blendRatio }
// - scores: { cautionary, optimistic, neutral }
```

**What Should Be Reflected:**
- All AI interfaces should use `getInterpolatedTone()` for consistent tone
- Tone information should be passed to backend via `toneWeight` in context
- System prompts should include tone guidance based on interpolation result
- Soft tone hints can be used for gradual blending in prompts

---

### 2. Temporal Awareness Layer

**Purpose:** Tracks time since last signal and uses temporal context in AI prompts to explain market consolidation or inactivity.

**Location:** `public/index.html` (lines ~2543-2575)

**Key Functions:**
- `updateLastSignalTimestamp(symbol, strategy, timestamp)`
- `getTimeSinceLastSignal(symbol)`

**How It Works:**
1. Tracks `lastSignalAt` timestamps per symbol/strategy in `lastSignalTimestamps` Map
2. Calculates hours/minutes since last signal
3. Includes temporal context in prompts (e.g., "No trades for 18 hours suggests consolidation")
4. Automatically updates when valid signals are detected

**Data Structure:**
```javascript
lastSignalTimestamps = Map {
  'BTCUSDT': {
    timestamp: 1706352000000,
    strategy: 'TREND_4H',
    iso: '2025-01-27T12:34:56.789Z'
  }
}
```

**Temporal Context in Prompts:**
- "No trades have fired for 18 hours — this usually suggests consolidation. Waiting for structure confirmation."
- "It's been 6 hours since the last signal. The market may be consolidating."
- "Last signal was 1 hour ago."

**Frontend Integration:**
```javascript
// Automatically included in buildPulseContext()
const timeSinceLastSignal = getTimeSinceLastSignal(symbol);
// Returns: { hours, minutes, totalHours, timestamp, iso, strategy }

// Updates automatically when signal detected
if (bestSignal && strategies[bestSignal].valid) {
  updateLastSignalTimestamp(symbol, bestSignal, Date.now());
}
```

**What Should Be Reflected:**
- All AI interfaces should include `lastSignalAt` and `hoursSinceLastSignal` in context
- Backend prompts should use temporal context to explain market inactivity
- Temporal guidance should be added to user prompts automatically
- Context should update when new valid signals are detected

---

### 3. Dynamic Prompt Weighting

**Purpose:** Instead of static tone switches, scores signals + bias and blends tone weight accordingly for gradual interpolation.

**Location:** Uses Tone Interpolation Module (see above)

**How It Works:**
1. Calculates component scores (risk, trend, signals)
2. Applies weighted scoring system
3. Interpolates wording gradually vs flipping tone presets
4. Example: 4 bearish TFs + risk-off = toneWeight 0.85 toward cautionary

**Frontend Integration:**
- Automatically applied via `calculateDynamicToneWeight()`
- Can be overridden with explicit `overrideTone` parameter
- Tone weight information passed to backend via `toneWeight` in context

**What Should Be Reflected:**
- All AI interfaces should use dynamic weighting (not static tone switches)
- Tone weight should be included in context for backend prompt interpolation
- Backend should use `softToneHints` for gradual blending guidance
- Override flags should be respected when provided

---

### 4. Bear Mode / Risk-Off Auto-Detection

**Purpose:** Automatically detects bear market conditions or risk-off user profile and adjusts tone accordingly.

**Location:** `public/index.html` (uses Tone Interpolation Module)

**Detection Logic:**
- User risk profile set to `risk-off` (localStorage: `userRiskProfile`)
- HTF bias is short with confidence ≥ 70%
- 60%+ of timeframes show bearish trends

**How It Works:**
- Uses `calculateDynamicToneWeight()` which calls `getInterpolatedTone()`
- Sets tone to `cautionary` when dynamic weight ≥ 0.6
- Can be overridden by explicit tone parameter or dev config

**Frontend Integration:**
```javascript
// Automatically detected in getMarketPulse()
const toneWeight = calculateDynamicToneWeight(data, symbol);
if (toneWeight.tone === 'cautionary' && toneWeight.weight >= 0.6) {
  // Bear mode detected
}
```

**What Should Be Reflected:**
- All AI interfaces should respect bear mode detection
- Tone should automatically shift to cautionary when conditions met
- User risk profile should be checked from localStorage
- Bear mode should be clearly indicated in AI responses

---

### 5. Response Caching

**Purpose:** Avoids repeated API hits by caching responses for 60 seconds unless market state changes significantly.

**Location:** `public/index.html` (lines ~2470-2541)

**Key Functions:**
- `getPulseCacheKey(symbol, target, tone, depth, temperature)`
- `getMarketStateHash(context)`
- `isCacheValid(cacheKey, currentContextHash)`

**How It Works:**
1. Cache key includes: symbol, target, tone, depth, temperature
2. Market state hash includes: HTF bias, active signals, trends, volume quality, price
3. Cache invalidates if:
   - Age > 60 seconds (TTL)
   - Market state hash changes (significant market changes)
4. Automatic cleanup (keeps last 50 entries)

**Cache Structure:**
```javascript
pulseCache = Map {
  'BTCUSDT:dashboard:neutral:normal:0.5': {
    pulse: 'Market analysis text...',
    timestamp: 1706352000000,
    contextHash: 'BTCUSDT|STANDARD|long|75|1|UPTREND|UPTREND|MEDIUM|91371'
  }
}
```

**Frontend Integration:**
```javascript
// Automatically used in getMarketPulse()
const cacheKey = getPulseCacheKey(symbol, target, tone, depth, temperature);
const contextHash = getMarketStateHash(pulseContext);

if (isCacheValid(cacheKey, contextHash)) {
  return pulseCache.get(cacheKey).pulse; // Return cached response
}
```

**What Should Be Reflected:**
- All Market Pulse Intelligence calls should use caching
- Cache should invalidate on significant market state changes
- Cache key should include all variable parameters
- Cache cleanup should prevent memory leaks

---

### 6. Global Fallbacks

**Purpose:** Ensures AI always returns a string (never null) with helpful fallback messages when data is unavailable.

**Location:** `public/index.html`, `api/agent-review.js`

**Fallback Messages:**
- Missing data: "Market data for [SYMBOL] is currently unavailable. Please check again soon."
- API error: Same fallback message
- Invalid context: Same fallback message
- Empty AI response: Same fallback message

**How It Works:**
1. Frontend checks for data availability
2. Returns fallback message if data missing
3. Backend returns fallback instead of error (200 status)
4. Always returns string, never null

**Frontend Integration:**
```javascript
// In getMarketPulse()
if (!data) {
  return `Market data for ${symbol} is currently unavailable. Please check again soon.`;
}

// In API handler
if (!apiKey) {
  return res.status(200).json({
    success: true,
    pulse: `Market data for ${context.symbol} is currently unavailable. Please check again soon.`,
    fallback: true
  });
}
```

**What Should Be Reflected:**
- All AI functions should return strings (never null)
- Fallback messages should be user-friendly
- API should return 200 status with fallback (not error)
- Frontend should handle fallback messages gracefully

---

### 7. Context Routing

**Purpose:** Ensures all AI analysis points receive the new rich context structure (htfBias, timeframes, marketData, dflowData).

**Location:** All AI interfaces

**Context Structure:**
```javascript
{
  symbol: "BTCUSDT",
  mode: "STANDARD" | "AGGRESSIVE",
  price: 91371,
  htfBias: {
    direction: "long",
    confidence: 75,
    source: "1h"
  },
  timeframes: {
    "4h": { trend: "up", ema21: 91000, stochRsi: {...} },
    "1h": { trend: "up", ema21: 91200, stochRsi: {...} },
    // ... all timeframes
  },
  marketData: {
    volumeQuality: "MEDIUM",
    spread: 0.5,
    bidAskImbalance: 0,
    // ... all market data
  },
  dflowData: {
    markets: [...],
    // ... prediction market data
  },
  lastSignalAt: "2025-01-27T12:34:56.789Z",
  hoursSinceLastSignal: 2.5,
  toneWeight: {
    finalTone: "optimistic",
    weight: 0.75,
    softToneHints: {...}
  }
}
```

**Routing by Interface:**

**Marquee AI (`getAIMarketReview`):**
- Uses `buildRichSymbolFromScanResults()` to get full context
- Aggregates context across all symbols
- Includes: `htfBias`, `timeframes`, `marketData`, `dflowData`

**Details Section AI (`getAIReview`):**
- Uses `createDashboardView()` which includes all new context
- Symbol-specific context
- Includes: `htfBias`, `timeframes`, `marketData`, `dflowData`, `toneWeight`

**Trade Tracker AI (`analyzeTrade`):**
- Uses `/api/analyze-full` endpoint for full context
- Trade-specific context
- Includes: `htfBias`, `timeframes`, `marketData`, `dflowData`, `toneWeight`

**Market Pulse Intelligence (`getMarketPulse`):**
- Uses `buildPulseContext()` which includes all new context
- Symbol-specific context
- Includes: `htfBias`, `timeframes`, `marketData`, `dflowData`, temporal awareness, `toneWeight`

**Frontend Integration:**
```javascript
// Debug logging confirms context routing
console.log(`🧠 [getAIReview] ${symbol}: Context includes htfBias:`, !!marketSnapshot.htfBias);
console.log(`🧠 [getAIReview] ${symbol}: Context includes timeframes:`, !!marketSnapshot.timeframes);
console.log(`🧠 [getAIReview] ${symbol}: Context includes marketData:`, !!marketSnapshot.marketData);
console.log(`🧠 [getAIReview] ${symbol}: Context includes dflowData:`, !!marketSnapshot.dflowData);
```

**What Should Be Reflected:**
- All AI interfaces must include rich context structure
- Context should be verified with debug logging
- Backend should receive complete context for accurate analysis
- Missing context fields should have fallback values

---

### 8. Dev-Only Prompt Tuning

**Purpose:** Allows developers to tweak AI prompts globally without code changes (localhost/development only).

**Location:** `public/index.html` (PULSE_DEV_CONFIG), `api/agent-review.js` (environment variables)

**Frontend Config:**
```javascript
const PULSE_DEV_CONFIG = {
  enabled: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1',
  systemPromptTone: 'neutral',  // Override default tone globally
  temperatureCap: 0.8,          // Maximum temperature allowed
  messageFormat: {
    dashboard: 'normal',
    'trade-panel': 'normal',
    marquee: 'short'
  }
};
```

**Backend Config (Environment Variables):**
```bash
PULSE_DEV_TONE=optimistic
PULSE_DEV_TEMP_CAP=0.7
PULSE_DEV_DEPTH_DASHBOARD=detailed
PULSE_DEV_DEPTH_TRADE_PANEL=normal
PULSE_DEV_DEPTH_MARQUEE=short
```

**What Should Be Reflected:**
- Dev config should only work on localhost/development
- Config should override default values when enabled
- Backend should check `NODE_ENV` or `VERCEL_ENV` for dev mode
- Config should not affect production deployments

---

## AI Components

### 1. Marquee AI (Market Review)

**Location:** `public/index.html` - Scrolling marquee banner at top of page

**Purpose:** Provides a high-level market sentiment analysis across all assets (BTC, ETH, SOL) and both trading modes (SAFE/AGGRESSIVE).

**Trigger:**
- Automatically on page load (after 5 seconds)
- Refreshes every 5 minutes
- Manual refresh available

**Features Used:**
- ✅ Tone Interpolation (aggregates scores across all symbols)
- ✅ Context Routing (receives rich context via `buildRichSymbolFromScanResults`)
- ✅ Temporal Awareness (includes time since last signals)
- ✅ Dynamic Prompt Weighting (market-wide tone calculation)
- ✅ Fallbacks (returns message if API fails)

**Data Input:**
```javascript
{
  tradesData: {
    SAFE_MODE: {
      BTCUSDT: {
        currentPrice: 91371,
        htfBias: { direction: "long", confidence: 75 },
        timeframes: {...},
        marketData: {...},
        dflowData: {...},
        strategies: {...}
      },
      // ... ETHUSDT, SOLUSDT
    },
    AGGRESSIVE_MODE: {
      // ... same structure
    }
  },
  systemPrompt: "When analyzing trade JSON, respond with direct, concise market insight..."
}
```

**Tone Calculation:**
```javascript
// Aggregates scores across all symbols
let aggregateRiskScore = 0;
let aggregateTrendScore = 0;
let aggregateSignalScore = 0;

for (const symbol of symbols) {
  const scores = calculateToneScores(data, symbol);
  aggregateRiskScore += scores.riskScore;
  aggregateTrendScore += scores.trendScore;
  aggregateSignalScore += scores.signalScore;
}

// Average scores
const marketTone = getInterpolatedTone({
  riskScore: aggregateRiskScore / symbolCount,
  trendScore: aggregateTrendScore / symbolCount,
  signalScore: aggregateSignalScore / symbolCount
});

// Include tone guidance in system prompt
const toneGuidance = marketTone.softToneHints.secondary 
  ? `Tone: ${marketTone.finalTone} (blend with ${marketTone.softToneHints.secondary} at ${(marketTone.softToneHints.blendRatio * 100).toFixed(0)}% strength).`
  : `Tone: ${marketTone.finalTone} (${(marketTone.weight * 100).toFixed(0)}% strength).`;
```

**System Prompt:**
```
When analyzing trade JSON, respond with direct, concise market insight. 
Avoid technical jargon unless necessary. Focus on what the market is behaving 
like rather than what indicators say. Identify whether assets influence each 
other and call out any shared momentum or correlation. If no trades appear, 
state why the structure isn't clean. [TONE_GUIDANCE] Tone should be confident, 
observational, and actionable—similar to a seasoned trader explaining what they 
see without fluff. Always keep responses tight, honest, and rooted in the bigger 
picture sentiment behind the data, not just the numbers. Keep your response to 
1-2 sentences maximum.
```

**LLM Settings:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.7` (more creative, conversational)
- **Max Tokens:** `150` (very concise)

**Output:**
- Single sentence or two-sentence market sentiment
- Displayed in scrolling marquee
- Example: "BTC and ETH showing aligned bullish momentum with clean 4H structure, while SOL consolidates."

**Frontend Functions:**
- `getAIMarketReview()` - Fetches and displays market review
- `updateMarketReviewDisplay()` - Updates marquee content
- `startMarketReview()` - Initializes and schedules refreshes

**Code Location:**
- `public/index.html` lines ~2313-2450

---

### 2. Details Section AI (Individual Trade Analysis)

**Location:** `public/index.html` - Details dropdown for each symbol

**Purpose:** Provides detailed analysis of a specific trade call for a symbol and strategy type.

**Trigger:**
- Automatically on page load for major coins (BTC, ETH, SOL) - silent mode
- Manual trigger via "ANALYZE" button in details dropdown
- Updates when strategy selection changes

**Features Used:**
- ✅ Tone Interpolation (symbol-specific scores)
- ✅ Context Routing (receives context via `createDashboardView`)
- ✅ Temporal Awareness (includes time since last signal)
- ✅ Dynamic Prompt Weighting (symbol-specific tone)
- ✅ Fallbacks (returns message if API fails)

**Data Input:**
```javascript
{
  symbol: "BTCUSDT",
  setupType: "4h" | "Swing" | "Scalp" | "MicroScalp",
  marketSnapshot: {
    symbol: "BTCUSDT",
    currentPrice: 91371,
    htfBias: { direction: "long", confidence: 75 },
    timeframes: {...},
    marketData: {...},
    dflowData: {...},
    toneWeight: {
      finalTone: "optimistic",
      weight: 0.75,
      softToneHints: {...}
    }
  }
}
```

**Tone Calculation:**
```javascript
// Calculate tone for this symbol
const scores = calculateToneScores(data, symbol);
const symbolTone = getInterpolatedTone({
  riskScore: scores.riskScore,
  trendScore: scores.trendScore,
  signalScore: scores.signalScore
});

// Add tone information to market snapshot
marketSnapshot.toneWeight = symbolTone;
```

**System Prompt:**
Strategy-specific prompts are dynamically constructed. Base structure includes tone guidance from `toneWeight`.

**LLM Settings:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.3` (more focused, analytical)
- **Max Tokens:** `800` (detailed analysis)

**Output:**
- 3-5 paragraph conversational analysis
- Includes rating: A+, A, B, or SKIP
- Strategy-specific evaluation
- Actionable insights

**Frontend Functions:**
- `getAIReview(symbol, isAutoTrigger)` - Fetches and displays analysis
- `autoTriggerAIAnalysis()` - Auto-triggers for major coins

**Code Location:**
- `public/index.html` lines ~4974-5100
- `api/agent-review.js` lines ~130-460

---

### 3. Trade Tracker AI (Active Position Analysis)

**Location:** `public/tracker.html` - Active trade position analysis

**Purpose:** Provides real-time analysis of an active or pending trade position.

**Trigger:**
- Manual trigger via "ANALYZE" button on each active trade
- Only available for ACTIVE or PENDING trades (not CLOSED)

**Features Used:**
- ✅ Tone Interpolation (trade-specific scores, includes functions in tracker.html)
- ✅ Context Routing (receives context via `/api/analyze-full`)
- ✅ Temporal Awareness (includes time since last signal)
- ✅ Dynamic Prompt Weighting (trade-specific tone)
- ✅ Fallbacks (returns message if API fails)

**Data Input:**
```javascript
{
  marketSnapshot: {
    symbol: "BTCUSDT",
    currentPrice: 91371,
    htfBias: { direction: "long", confidence: 75 },
    timeframes: {...},
    marketData: {...},
    dflowData: {...},
    toneWeight: {
      finalTone: "optimistic",
      weight: 0.75
    }
  },
  setupType: "SCALP" | "4h" | "Swing" | "MicroScalp",
  symbol: "BTCUSDT"
}
```

**Tone Calculation:**
```javascript
// Reconstruct data-like object from marketSnapshot
const tradeData = {
  htfBias: marketSnapshot.htfBias,
  analysis: marketSnapshot.analysis,
  richSymbol: {
    strategies: {
      [trade.strategy]: {
        valid: marketSnapshot.signal.valid,
        direction: marketSnapshot.signal.direction,
        confidence: marketSnapshot.signal.confidence || 0
      }
    }
  }
};

const scores = calculateToneScores(tradeData, trade.symbol);
const tradeTone = getInterpolatedTone({
  riskScore: scores.riskScore,
  trendScore: scores.trendScore,
  signalScore: scores.signalScore
});

marketSnapshot.toneWeight = tradeTone;
```

**System Prompt:**
Uses the same strategy-specific prompts as Details Section AI, but with context that this is an **active position** being analyzed.

**LLM Settings:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.3`
- **Max Tokens:** `800`

**Output:**
- Analysis of current position status
- Market context changes since entry
- Risk assessment
- Position management recommendations

**Frontend Functions:**
- `analyzeTrade(tradeId)` - Analyzes active trade position
- `calculateToneScores()` - Included in tracker.html
- `getInterpolatedTone()` - Included in tracker.html

**Code Location:**
- `public/tracker.html` lines ~693-900 (tone functions), ~2379-2450 (analyzeTrade)
- `api/agent-review.js` (same endpoint, different context)

---

### 4. Market Pulse Intelligence

**Location:** Can be used in any context (dashboard, trade panel, marquee, notifications)

**Purpose:** Provides adaptive, context-aware market analysis that automatically explains market conditions, signal availability, and what to monitor next.

**Trigger:**
- Can be called programmatically from any frontend location
- Can replace or enhance existing marquee AI
- Can be used in details sections
- Can be triggered on-demand or automatically

**Features Used:**
- ✅ Tone Interpolation (symbol-specific scores)
- ✅ Context Routing (receives context via `buildPulseContext`)
- ✅ Temporal Awareness (includes `lastSignalAt` and `hoursSinceLastSignal`)
- ✅ Dynamic Prompt Weighting (symbol-specific tone)
- ✅ Response Caching (60s TTL with market state change detection)
- ✅ Global Fallbacks (always returns string)
- ✅ Dev-Only Prompt Tuning (localhost/development config)

**Data Input:**
```javascript
{
  pulseContext: {
    symbol: "BTCUSDT",
    mode: "STANDARD" | "AGGRESSIVE",
    price: 91371,
    htfBias: { direction: "long", confidence: 75 },
    trendMap: {
      "3d": "FLAT",
      "1d": "FLAT",
      "4h": "FLAT",
      "1h": "UPTREND",
      "15m": "UPTREND"
    },
    volatility3d: "9.8%",
    volumeQuality: "MEDIUM",
    dflowStatus: "Available" | "Unavailable",
    activeSignals: 1,
    lastSignalAt: "2025-01-27T12:34:56.789Z",
    hoursSinceLastSignal: 2.5,
    toneWeight: {
      finalTone: "optimistic",
      weight: 0.75,
      softToneHints: {
        primary: "optimistic",
        secondary: "neutral",
        blendRatio: 0.75
      }
    }
  },
  pulseVariables: {
    tone: "neutral" | "optimistic" | "cautionary" | "assertive",
    depth: "short" | "normal" | "detailed",
    target: "dashboard" | "trade-panel" | "marquee",
    temperature: "0.2" | "0.5" | "0.8"
  }
}
```

**Tone Calculation:**
```javascript
// Calculate dynamic tone weighting
const toneWeight = calculateDynamicToneWeight(data, symbol);

// Apply dynamic tone if base tone is neutral or if weight is strong
if (tone === 'neutral' || toneWeight.weight >= 0.6) {
  tone = toneWeight.tone;
}

// Add tone weight information to context
pulseContext.toneWeight = toneWeight;
```

**System Prompt:**
Dynamically constructed based on variables and includes temporal awareness and tone blending guidance.

**LLM Settings:**
- **Model:** `gpt-4o-mini`
- **Temperature:** Variable (0.2-0.8, default 0.5)
- **Max Tokens:** 
  - `short`: 100 tokens
  - `normal`: 300 tokens
  - `detailed`: 600 tokens

**Output Examples:**

**Dashboard | Neutral | Short:**
```
BTC is rangebound. 4H and 1D trends are flat, so the system is holding 
off on entries. 1H is pushing up, but more confluence is needed.
```

**Trade-Panel | Optimistic | Normal:**
```
No trades yet, but signs are shifting. 1H is in a clean uptrend and 
HTF bias is now long with 75% confidence. If 4H breaks upward or volume 
improves, expect potential signals in the next 6–12 hours.
```

**Marquee | Cautionary | Short:**
```
Market's been indecisive the last few days. Volatility high, trends 
conflicting. No clean setups for now—patience is smart here.
```

**Frontend Functions:**
- `getMarketPulse(symbol, target, tone, depth, temperature)` - Fetches adaptive analysis
- `buildPulseContext(data, symbol)` - Builds context from existing data
- `getPulseCacheKey(...)` - Generates cache key
- `getMarketStateHash(context)` - Generates market state hash
- `isCacheValid(cacheKey, contextHash)` - Checks cache validity

**Code Location:**
- `api/agent-review.js` - `handleMarketPulse()` function (lines ~10-240)
- `public/index.html` - Frontend integration functions (lines ~2690-2795)

---

## Frontend Integration Guide

### Required Context Structure

All AI interfaces must include this context structure:

```javascript
{
  symbol: string,
  mode: "STANDARD" | "AGGRESSIVE",
  price: number,
  htfBias: {
    direction: "long" | "short" | "neutral",
    confidence: number (0-100),
    source: string
  },
  timeframes: {
    [timeframe]: {
      trend: string,
      ema21: number,
      ema200: number,
      stochRsi: {...}
    }
  },
  marketData: {
    volumeQuality: string,
    spread: number,
    bidAskImbalance: number,
    // ... all market data
  },
  dflowData: {
    markets: [...],
    // ... prediction market data
  },
  lastSignalAt: string (ISO timestamp),
  hoursSinceLastSignal: number,
  toneWeight: {
    finalTone: string,
    weight: number,
    softToneHints: {...},
    scores: {...}
  }
}
```

### Integration Checklist

**For Each AI Interface:**

1. ✅ **Include Tone Interpolation:**
   ```javascript
   const scores = calculateToneScores(data, symbol);
   const toneResult = getInterpolatedTone({...});
   context.toneWeight = toneResult;
   ```

2. ✅ **Include Temporal Awareness:**
   ```javascript
   const timeSinceLastSignal = getTimeSinceLastSignal(symbol);
   context.lastSignalAt = timeSinceLastSignal?.iso;
   context.hoursSinceLastSignal = timeSinceLastSignal?.totalHours;
   ```

3. ✅ **Include Rich Context:**
   ```javascript
   context.htfBias = data.htfBias || data.richSymbol?.htfBias;
   context.timeframes = data.timeframes || data.richSymbol?.timeframes;
   context.marketData = data.marketData || data.richSymbol?.marketData;
   context.dflowData = data.dflowData || data.richSymbol?.dflowData;
   ```

4. ✅ **Add Debug Logging:**
   ```javascript
   console.log(`🧠 [Interface] ${symbol}: Context includes htfBias:`, !!context.htfBias);
   console.log(`🧠 [Interface] ${symbol}: Context includes timeframes:`, !!context.timeframes);
   console.log(`🧠 [Interface] ${symbol}: Context includes marketData:`, !!context.marketData);
   console.log(`🧠 [Interface] ${symbol}: Context includes dflowData:`, !!context.dflowData);
   console.log(`🧠 [Interface] ${symbol}: Tone: ${toneResult.finalTone} (weight: ${toneResult.weight.toFixed(2)})`);
   ```

5. ✅ **Include Fallbacks:**
   ```javascript
   if (!data) {
     return `Market data for ${symbol} is currently unavailable. Please check again soon.`;
   }
   ```

6. ✅ **Pass Tone to Backend:**
   ```javascript
   body: JSON.stringify({
     ...context,
     toneWeight: toneResult  // Include tone weight
   })
   ```

### Example: Complete Integration

```javascript
async function myAIFunction(symbol) {
  const data = scanResults[symbol];
  if (!data) {
    return `Market data for ${symbol} is currently unavailable. Please check again soon.`;
  }
  
  // 1. Calculate tone
  const scores = calculateToneScores(data, symbol);
  const toneResult = getInterpolatedTone({
    riskScore: scores.riskScore,
    trendScore: scores.trendScore,
    signalScore: scores.signalScore,
    overrideTone: null,
    allowOverride: true
  });
  
  // 2. Build context
  const context = {
    symbol: symbol,
    mode: data.mode || 'STANDARD',
    price: data.currentPrice,
    htfBias: data.htfBias || data.richSymbol?.htfBias,
    timeframes: data.timeframes || data.richSymbol?.timeframes || {},
    marketData: data.marketData || data.richSymbol?.marketData || null,
    dflowData: data.dflowData || data.richSymbol?.dflowData || null,
    toneWeight: toneResult
  };
  
  // 3. Add temporal awareness
  const timeSinceLastSignal = getTimeSinceLastSignal(symbol);
  if (timeSinceLastSignal) {
    context.lastSignalAt = timeSinceLastSignal.iso;
    context.hoursSinceLastSignal = timeSinceLastSignal.totalHours;
  }
  
  // 4. Debug logging
  console.log(`🧠 [myAIFunction] ${symbol}: Tone: ${toneResult.finalTone} (weight: ${toneResult.weight.toFixed(2)})`);
  console.log(`🧠 [myAIFunction] ${symbol}: Context includes all required fields`);
  
  // 5. Call API
  const response = await fetch('/api/agent-review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol,
      context,
      // ... other parameters
    })
  });
  
  // 6. Handle response
  const result = await response.json();
  return result.analysis || `Market analysis for ${symbol} is temporarily unavailable.`;
}
```

---

## API Endpoint

### `/api/agent-review`

**Location:** `api/agent-review.js`

**Method:** `POST`

**Request Body (Three Modes):**

#### Mode 1: Market Review (Marquee)
```javascript
{
  tradesData: {
    SAFE_MODE: { /* all symbols with rich context */ },
    AGGRESSIVE_MODE: { /* all symbols with rich context */ }
  },
  systemPrompt: "When analyzing trade JSON, respond with direct, concise market insight..."
}
```

#### Mode 2: Individual Trade Analysis (Details/Tracker)
```javascript
{
  symbol: "BTCUSDT",
  setupType: "4h" | "Swing" | "Scalp" | "MicroScalp",
  marketSnapshot: {
    /* symbol-specific data with rich context */
    toneWeight: { /* tone interpolation result */ }
  }
}
```

#### Mode 3: Market Pulse Intelligence
```javascript
{
  pulseRequest: true,
  pulseContext: {
    /* context with temporal awareness and tone weight */
  },
  pulseVariables: {
    tone: "neutral" | "optimistic" | "cautionary" | "assertive",
    depth: "short" | "normal" | "detailed",
    target: "dashboard" | "trade-panel" | "marquee",
    temperature: "0.2" | "0.5" | "0.8"
  }
}
```

**Response:**
```javascript
// Market Review Mode
{
  success: true,
  review: "Market sentiment analysis...",
  timestamp: "2025-01-27T12:34:56.789Z"
}

// Individual Trade Analysis Mode
{
  success: true,
  symbol: "BTCUSDT",
  setupType: "4h",
  priority: "A" | "A+" | "B" | "SKIP",
  formattedText: "Detailed analysis paragraphs...",
  timestamp: "2025-01-27T12:34:56.789Z"
}

// Market Pulse Intelligence Mode
{
  success: true,
  pulse: "Adaptive market analysis...",
  context: {
    symbol: "BTCUSDT",
    mode: "STANDARD",
    tone: "optimistic",
    depth: "normal",
    target: "dashboard"
  },
  timestamp: "2025-01-27T12:34:56.789Z",
  fallback: false
}
```

**Error Response:**
```javascript
{
  error: "Error message",
  message: "Detailed error description",
  details: "ErrorType"
}
```

---

## LLM Configuration

### OpenAI Configuration

**Provider:** OpenAI  
**Model:** `gpt-4o-mini`  
**API Endpoint:** `https://api.openai.com/v1/chat/completions`

**Environment Variable:**
```bash
OPENAI_API_KEY=sk-...
```

**API Key Setup:**
1. Get API key from OpenAI dashboard
2. Add to Vercel environment variables
3. Key is accessed via `process.env.OPENAI_API_KEY`

**Rate Limits:**
- Model: `gpt-4o-mini`
- Default rate limits apply (check OpenAI dashboard)
- System includes delays between requests to avoid overwhelming API

**Cost Considerations:**
- `gpt-4o-mini` is cost-effective for high-volume analysis
- Market Review: ~150 tokens per request
- Individual Analysis: ~800 tokens per request
- Market Pulse: ~100-600 tokens per request (depending on depth)
- Auto-triggered analysis runs for 3 symbols on page load
- Caching reduces redundant API calls

---

## System Prompts

### Prompt Structure

All prompts follow this structure:

1. **Role Definition:** "You are the Trading Reasoning Layer for EditTrades" or "You are the Market Pulse AI"
2. **Job Description:** What the AI should analyze
3. **Tone Guidance:** From tone interpolation result
4. **Temporal Context:** Time since last signal (if applicable)
5. **Strategy-Specific Guidance:** Custom rules for each strategy type
6. **General Rules:** Constraints and formatting requirements
7. **Output Format:** How to structure the response

### Prompt Customization

**To modify prompts:**

1. **Marquee Prompt:** Edit `public/index.html` line ~2432
   ```javascript
   systemPrompt: 'When analyzing trade JSON, respond with direct, concise market insight...'
   ```

2. **Details/Tracker Prompts:** Edit `api/agent-review.js`
   - Base prompt: lines ~234-283
   - Strategy guidance: lines ~167-225
   - Analysis points: lines ~286-321

3. **Market Pulse Prompt:** Edit `api/agent-review.js`
   - System prompt: lines ~77-90
   - User prompt: lines ~146-155 (includes temporal and tone guidance)

### Prompt Best Practices

1. **Be Specific:** Include exact strategy requirements
2. **Set Constraints:** Clearly state what NOT to analyze (e.g., MicroScalp ignores 4H)
3. **Define Output Format:** Specify paragraph structure, length, rating system
4. **Include Examples:** Reference actual data structure in prompts
5. **Set Tone:** Use tone interpolation results for dynamic tone guidance
6. **Include Temporal Context:** Use time since last signal to explain inactivity
7. **Use Soft Tone Hints:** Guide gradual blending when secondary tone present

---

## Enhancement Guide

### Adding New AI Analysis Features

#### Step 1: Define Use Case
- What data will be analyzed?
- What output format is needed?
- Where will it be displayed?

#### Step 2: Integrate Tone Interpolation
```javascript
const scores = calculateToneScores(data, symbol);
const toneResult = getInterpolatedTone({
  riskScore: scores.riskScore,
  trendScore: scores.trendScore,
  signalScore: scores.signalScore
});
```

#### Step 3: Include Rich Context
```javascript
const context = {
  symbol, mode, price,
  htfBias, timeframes, marketData, dflowData,
  lastSignalAt, hoursSinceLastSignal,
  toneWeight: toneResult
};
```

#### Step 4: Create System Prompt
- Write clear role definition
- Include tone guidance from `toneResult`
- Include temporal context if applicable
- Define output format
- Set tone and style

#### Step 5: Update API Endpoint
- Add new mode handler in `api/agent-review.js`
- Or create new endpoint if needed
- Include error handling and fallbacks

#### Step 6: Frontend Integration
- Add HTML element for display
- Create JavaScript function to fetch analysis
- Include tone interpolation and context routing
- Add trigger mechanism (auto or manual)
- Style the output

#### Step 7: Test
- Test with real data
- Verify prompt produces desired output
- Check error handling
- Test rate limiting
- Verify caching works (if applicable)

### Modifying Existing Prompts

#### To Change Analysis Style:

1. **Edit System Prompt** in `api/agent-review.js`
2. **Adjust Temperature:**
   - Lower (0.1-0.3) = More focused, analytical
   - Higher (0.7-1.0) = More creative, conversational
3. **Adjust Max Tokens:**
   - Shorter = More concise
   - Longer = More detailed
4. **Update Strategy Guidance** if needed
5. **Include Tone Guidance** from interpolation result

#### To Add New Strategy Type:

1. **Add Strategy Guidance** in `strategyGuidance` object (line ~167)
2. **Add Analysis Points** in `analysisPoints` object (line ~286)
3. **Update Frontend** to handle new strategy type
4. **Test** with real data

### Switching LLM Providers

#### To Use Different Model:

1. **Update Model Name** in API calls:
   ```javascript
   model: 'gpt-4o-mini' // Change to desired model
   ```

2. **Update API Endpoint** if using different provider:
   ```javascript
   const response = await fetch('https://api.openai.com/v1/chat/completions', {
     // Change endpoint if needed
   });
   ```

3. **Update Environment Variables:**
   ```bash
   OPENAI_API_KEY=... # Or provider-specific key
   ```

4. **Adjust Parameters:**
   - Temperature ranges may differ
   - Token limits may differ
   - Rate limits will differ

---

## Troubleshooting

### Common Issues

#### 1. AI Analysis Not Appearing

**Symptoms:**
- Marquee shows "Analyzing Market Sentiment" indefinitely
- Details section shows loading animation forever
- No error messages

**Solutions:**
- Check `OPENAI_API_KEY` is set in environment variables
- Check browser console for API errors
- Verify API endpoint is accessible
- Check rate limits haven't been exceeded
- Verify context structure is complete

#### 2. API Key Not Found

**Symptoms:**
- Error: "OpenAI API key not configured"
- Returns placeholder response in local dev

**Solutions:**
- Add `OPENAI_API_KEY` to Vercel environment variables
- Restart deployment after adding key
- Check key is correctly named (case-sensitive)

#### 3. Rate Limit Errors

**Symptoms:**
- Error: "Rate limit exceeded"
- Some analyses fail randomly

**Solutions:**
- Add delays between requests (already implemented)
- Reduce auto-trigger frequency
- Use caching (already implemented for Market Pulse)
- Upgrade OpenAI plan if needed

#### 4. Incorrect Analysis

**Symptoms:**
- AI mentions wrong strategy requirements
- Analysis contradicts system rules

**Solutions:**
- Check system prompt matches strategy type
- Verify `setupType` is correctly passed
- Review strategy-specific guidance in prompt
- Test with known good/bad setups
- Verify tone interpolation is working correctly

#### 5. Response Too Long/Short

**Symptoms:**
- Analysis cuts off mid-sentence
- Analysis is too brief

**Solutions:**
- Adjust `max_tokens` parameter
- Modify prompt to request specific length
- Check token usage in OpenAI dashboard

#### 6. Tone Not Reflecting Market Conditions

**Symptoms:**
- AI tone doesn't match market conditions
- Bear mode not detected

**Solutions:**
- Verify `calculateToneScores()` is being called
- Check `getInterpolatedTone()` is receiving correct scores
- Verify risk profile is set in localStorage
- Check HTF bias is included in context
- Review tone weight calculation logic

#### 7. Temporal Context Missing

**Symptoms:**
- AI doesn't mention time since last signal
- Temporal awareness not working

**Solutions:**
- Verify `updateLastSignalTimestamp()` is called when signals detected
- Check `getTimeSinceLastSignal()` returns correct values
- Ensure `lastSignalAt` and `hoursSinceLastSignal` are in context
- Verify backend prompt includes temporal guidance

### Debugging

#### Enable Detailed Logging:

The API endpoint includes extensive logging. Check:
- Browser console for frontend logs
- Vercel function logs for backend logs
- Look for `🧠 [Tone Interpolation]` prefixed logs
- Look for `🧠 [Interface]` prefixed logs for context verification

#### Test API Directly:

```bash
curl -X POST https://your-domain.vercel.app/api/agent-review \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "setupType": "4h",
    "marketSnapshot": { /* test data with full context */ }
  }'
```

#### Check Response Structure:

Verify response matches expected format:
```javascript
{
  success: true,
  formattedText: "...",
  priority: "A",
  timestamp: "..."
}
```

#### Verify Context Routing:

Check browser console for context verification logs:
```javascript
🧠 [getAIReview] BTCUSDT: Context includes htfBias: true
🧠 [getAIReview] BTCUSDT: Context includes timeframes: true
🧠 [getAIReview] BTCUSDT: Context includes marketData: true
🧠 [getAIReview] BTCUSDT: Context includes dflowData: true
🧠 [getAIReview] BTCUSDT: Tone: optimistic (weight: 0.75)
```

---

## Best Practices

### Prompt Engineering

1. **Be Explicit:** Clearly state what to analyze and what to ignore
2. **Use Examples:** Include sample data structure in prompts
3. **Set Constraints:** Define what NOT to do (e.g., "DO NOT mention 4H for MicroScalp")
4. **Define Format:** Specify output structure (paragraphs, length, rating)
5. **Test Iteratively:** Refine prompts based on output quality
6. **Include Tone Guidance:** Use tone interpolation results in prompts
7. **Add Temporal Context:** Use time since last signal to explain inactivity

### Performance

1. **Cache Responses:** Use caching for Market Pulse Intelligence (60s TTL)
2. **Batch Requests:** Group multiple analyses when possible
3. **Rate Limiting:** Add delays between requests
4. **Error Handling:** Gracefully handle API failures
5. **Fallback Content:** Show placeholder when AI unavailable
6. **Cache Invalidation:** Invalidate cache on significant market state changes

### Cost Management

1. **Use Efficient Models:** `gpt-4o-mini` is cost-effective
2. **Limit Token Usage:** Set appropriate `max_tokens`
3. **Cache Responses:** Avoid redundant API calls (Market Pulse uses caching)
4. **Monitor Usage:** Track API usage in OpenAI dashboard
5. **Optimize Prompts:** Shorter prompts = lower costs

### Tone Management

1. **Use Tone Interpolation:** Always use `getInterpolatedTone()` for consistency
2. **Include Tone in Context:** Pass `toneWeight` to backend
3. **Respect Overrides:** Allow manual tone override when needed
4. **Use Soft Hints:** Guide gradual blending with `softToneHints`
5. **Update Timestamps:** Call `updateLastSignalTimestamp()` when signals detected

---

## Related Documentation

- `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` - Strategy details AI analyzes
- `docs/STRATEGY_MODES.md` - Mode differences AI considers
- `docs/SYSTEM_CONTEXT.md` - System architecture
- `docs/DEVELOPMENT_PROCEDURE.md` - Development workflow
- `docs/MARKETDATA_MODULE.md` - Market data structure AI uses

---

**Last Updated:** 2025-01-27  
**Version:** 2.0.0
