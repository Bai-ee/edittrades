# AI System Documentation

Complete reference for all AI analysis components in the EditTrades system.

**Last Updated:** 2025-01-27  
**Version:** 1.0.0

---

## Table of Contents

1. [Overview](#overview)
2. [AI Components](#ai-components)
3. [API Endpoint](#api-endpoint)
4. [LLM Configuration](#llm-configuration)
5. [System Prompts](#system-prompts)
6. [Frontend Integration](#frontend-integration)
7. [Enhancement Guide](#enhancement-guide)
8. [Troubleshooting](#troubleshooting)

---

## Overview

The EditTrades system uses **OpenAI's GPT-4o-mini** model to provide AI-powered trade analysis in three locations:

1. **Marquee** - Market-wide sentiment analysis (scrolling banner)
2. **Details Section** - Individual trade call analysis (per symbol)
3. **Trade Tracker** - Active position analysis (per tracked trade)
4. **Market Pulse Intelligence** - Adaptive context-aware market analysis (NEW)

All AI analysis flows through a single API endpoint (`/api/agent-review`) with different prompts and data structures depending on the use case.

### Market Pulse Intelligence (NEW)

A unified, adaptive AI system that automatically comments on current market state, justifies lack of signals when relevant, and adapts tone based on context. This system uses variable-controlled prompts that can be tuned system-wide without code changes.

---

## Market Pulse Intelligence (NEW)

**Location:** Can be used in any context (dashboard, trade panel, marquee, notifications)

**Purpose:** Provides adaptive, context-aware market analysis that automatically explains market conditions, signal availability, and what to monitor next.

**Key Features:**
- **Variable-Controlled Prompts:** Tone, depth, target, and temperature can be adjusted without code changes
- **Auto-Context Building:** Automatically extracts context from existing data structures
- **Adaptive Output:** Different formats for different contexts (dashboard, trade-panel, marquee)
- **Zero Manual Prompting:** Fully automated based on current market state

**Trigger:**
- Can be called programmatically from any frontend location
- Can replace or enhance existing marquee AI
- Can be used in details sections
- Can be triggered on-demand or automatically

**Data Input:**
```javascript
{
  pulseContext: {
    symbol: "BTCUSDT",
    mode: "STANDARD" | "AGGRESSIVE",
    price: 91371,
    htfBias: {
      direction: "long",
      confidence: 75,
      source: "1h"
    },
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
    activeSignals: 0,
    lastSignalTime: "2025-01-27T12:34:56.789Z"
  },
  pulseVariables: {
    tone: "neutral" | "optimistic" | "cautionary" | "assertive",
    depth: "short" | "normal" | "detailed",
    target: "dashboard" | "trade-panel" | "marquee",
    temperature: "0.2" | "0.5" | "0.8"
  }
}
```

**System Prompt:**
Dynamically constructed based on variables:
```
You are the Market Pulse AI, embedded in a crypto trading system. 
Your job is to interpret system-generated context and deliver timely, 
human-like summaries of market posture, strategy logic, and signal availability.

Tone: [tone] (neutral = balanced, optimistic = positive outlook, 
cautionary = warning, assertive = confident)
Depth: [depth] (short = 1-2 lines, normal = 1-2 paragraphs, 
detailed = multi-section)
Target: [target] (dashboard = overview, trade-panel = specific symbol, 
marquee = banner message)
Temperature: [temperature] (controls creativity/variability)

Rules:
- Do not invent signals. If none are present, explain why using current market structure.
- Mention key misalignments or flat trends blocking trades.
- Use trader-oriented reasoning: note what looks promising, what's blocking, 
  and what may trigger next.
- Format appropriately for [target] context.
- Keep [depth] length as specified.
- Use [tone] tone throughout.
```

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

**Code Location:**
- `api/agent-review.js` - `handleMarketPulse()` function
- `public/index.html` - Frontend integration functions

**Enhancement Guide:**
See [Enhancement Guide](#enhancement-guide) section for details on customizing prompts and variables.

---

## AI Components

### 1. Marquee AI (Market Review)

**Location:** `public/index.html` - Scrolling marquee banner at top of page

**Purpose:** Provides a high-level market sentiment analysis across all assets (BTC, ETH, SOL) and both trading modes (SAFE/AGGRESSIVE).

**Trigger:**
- Automatically on page load (after 5 seconds)
- Refreshes every 5 minutes
- Manual refresh available

**Data Input:**
```javascript
{
  tradesData: {
    SAFE_MODE: {
      BTCUSDT: { /* all strategies */ },
      ETHUSDT: { /* all strategies */ },
      SOLUSDT: { /* all strategies */ }
    },
    AGGRESSIVE_MODE: {
      BTCUSDT: { /* all strategies */ },
      ETHUSDT: { /* all strategies */ },
      SOLUSDT: { /* all strategies */ }
    }
  },
  systemPrompt: "When analyzing trade JSON, respond with direct, concise market insight..."
}
```

**System Prompt:**
```
When analyzing trade JSON, respond with direct, concise market insight. 
Avoid technical jargon unless necessary. Focus on what the market is behaving 
like rather than what indicators say. Identify whether assets influence each 
other and call out any shared momentum or correlation. If no trades appear, 
state why the structure isn't clean. Tone should be confident, observational, 
and actionable—similar to a seasoned trader explaining what they see without 
fluff. Always keep responses tight, honest, and rooted in the bigger picture 
sentiment behind the data, not just the numbers. Keep your response to 1-2 
sentences maximum.
```

**LLM Settings:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.7` (more creative, conversational)
- **Max Tokens:** `150` (very concise)

**Output:**
- Single sentence or two-sentence market sentiment
- Displayed in scrolling marquee
- Example: "BTC and ETH showing aligned bullish momentum with clean 4H structure, while SOL consolidates."

**Frontend Function:**
- `getAIMarketReview()` - Fetches and displays market review
- `updateMarketReviewDisplay()` - Updates marquee content
- `startMarketReview()` - Initializes and schedules refreshes

**Code Location:**
- `public/index.html` lines ~2310-2498

---

### 2. Details Section AI (Individual Trade Analysis)

**Location:** `public/index.html` - Details dropdown for each symbol

**Purpose:** Provides detailed analysis of a specific trade call for a symbol and strategy type.

**Trigger:**
- Automatically on page load for major coins (BTC, ETH, SOL) - silent mode
- Manual trigger via "ANALYZE" button in details dropdown
- Updates when strategy selection changes

**Data Input:**
```javascript
{
  symbol: "BTCUSDT",
  setupType: "4h" | "Swing" | "Scalp" | "MicroScalp",
  marketSnapshot: {
    symbol: "BTCUSDT",
    currentPrice: 91371,
    priceChange24h: 2.5,
    signal: {
      direction: "long",
      confidence: 76,
      valid: true,
      reason: "...",
      entryZone: { min: 90636, max: 91182 },
      stopLoss: 88181.73,
      targets: [93636.27, 96363.54],
      invalidation: 88181.73
    },
    htfBias: {
      direction: "long",
      confidence: 100,
      source: "1h"
    },
    analysis: {
      trendAlignment: "...",
      stochMomentum: "...",
      pullbackState: "...",
      liquidityZones: "...",
      htfConfirmation: "..."
    }
  }
}
```

**System Prompt:**
Strategy-specific prompts are dynamically constructed. Base structure:

```
You are the Trading Reasoning Layer for EditTrades.

Your job:
- Analyze EditTrades' JSON snapshot for [SETUP_TYPE] setup
- Apply strategy-specific rules for this trade type
- Use higher-level reasoning (momentum, HTF conflict, invalidation integrity)
- Add confluence checks
- Determine if THIS SPECIFIC TRADE TYPE is recommended
- Create a clean human-readable trade call
- Provide analysis that adds value beyond the raw data

[STRATEGY-SPECIFIC GUIDANCE]

Rules:
1. Never override numerical fields from EditTrades (entry, stop, tp1/2/3)
2. You may critique a trade if conditions contradict best practices for THIS strategy
3. Your analysis should be SPECIFIC to [SETUP_TYPE] - don't suggest a different strategy
4. Write in CONVERSATIONAL PARAGRAPHS, not bulleted lists
5. Structure your response as natural flowing text

[CONVERSATIONAL STRUCTURE GUIDANCE]
```

**Strategy-Specific Guidance:**

Each strategy type has custom guidance embedded in the system prompt:

#### 4H Trade Guidance:
```
4-HOUR TRADE SPECIFIC ANALYSIS:
- This is the core "set and forget" strategy
- CRITICAL: 4H trend must be clear (UPTREND/DOWNTREND, not FLAT)
- 1H must align with 4H direction
- Price must be in ENTRY_ZONE (near 4H 21 EMA, ±1%)
- 4H pullback state must be RETRACING or ENTRY_ZONE
- Stoch must show curl in trade direction on 4H
- Stop loss at 4H swing high/low
- Targets are 1:1 and 1:2 R (TP1/TP2)
- This is medium position, medium hold time
- Focus on: 4H trend clarity, EMA alignment, stoch momentum quality
```

#### Swing Trade Guidance:
```
SWING TRADE SPECIFIC ANALYSIS:
- This is a 3D → 1D → 4H multi-timeframe swing setup
- CRITICAL: 4H trend must NOT be FLAT (instant disqualification)
- Evaluate 3D oversold/overbought pivot quality
- Check 1D reclaim/rejection strength
- Confirm 4H is providing structural support
- Stop loss should be at 3D/1D swing levels (HTF invalidation)
- Targets should be 3R, 4R, 5R minimum
- This is a larger position, longer hold time
- Focus on: HTF momentum alignment, macro trend integrity, structural confluence
```

#### Scalp Trade Guidance:
```
SCALP TRADE SPECIFIC ANALYSIS:
- This is a 15m/5m lower timeframe scalp
- CRITICAL: 4H trend must be clear (NOT FLAT) and aligned
- 1H must confirm direction
- Both 15m and 5m must be in ENTRY_ZONE near 21 EMA
- Stoch must show strong momentum curl in direction
- Stop loss should be at 5m/15m swing levels (tight LTF stops)
- Targets are typically 1.5R to 3R (quick in/out)
- This is smaller position, fast execution
- Focus on: LTF momentum quality, tight confluence, clean entry zone
```

#### MicroScalp Trade Guidance:
```
MICRO-SCALP SPECIFIC ANALYSIS:
‼️ CRITICAL: This strategy COMPLETELY DISREGARDS 4H TREND ‼️
- DO NOT evaluate 4H trend - it is 100% IRRELEVANT to Micro-Scalp
- DO NOT mention "4H must be X" or "4H trend is..." - IGNORE IT ENTIRELY
- 4H can be UPTREND, DOWNTREND, or FLAT - DOESN'T MATTER AT ALL
- This is a LOWER TIMEFRAME ONLY strategy (1H/15m/5m)

WHAT ACTUALLY MATTERS FOR MICRO-SCALP:
- 1H trend must be clear (UPTREND or DOWNTREND, not FLAT)
- 1H pullback state must be ENTRY_ZONE or RETRACING
- 15m price within ±0.25% of 15m EMA21
- 5m price within ±0.25% of 5m EMA21
- Stoch aligned on BOTH 15m and 5m (oversold+bullish for long, overbought+bearish for short)
- Very tight stops at 15m/5m swing levels
- Quick targets (1.0R, 1.5R only)
- Smallest position size, fastest execution

Focus ONLY on: 1H trend quality, 15m/5m EMA precision, stoch alignment on LTF
DO NOT MENTION 4H TREND IN YOUR ANALYSIS - IT IS NOT A FACTOR
```

**LLM Settings:**
- **Model:** `gpt-4o-mini`
- **Temperature:** `0.3` (more focused, analytical)
- **Max Tokens:** `800` (detailed analysis)

**Output:**
- 3-5 paragraph conversational analysis
- Includes rating: A+, A, B, or SKIP
- Strategy-specific evaluation
- Actionable insights

**Frontend Function:**
- `getAIReview(symbol, isAutoTrigger)` - Fetches and displays analysis
- `autoTriggerAIAnalysis()` - Auto-triggers for major coins

**Code Location:**
- `public/index.html` lines ~4446-4550
- `api/agent-review.js` lines ~130-460

---

### 3. Trade Tracker AI (Active Position Analysis)

**Location:** `public/tracker.html` - Active trade position analysis

**Purpose:** Provides real-time analysis of an active or pending trade position.

**Trigger:**
- Manual trigger via "ANALYZE" button on each active trade
- Only available for ACTIVE or PENDING trades (not CLOSED)

**Data Input:**
```javascript
{
  marketSnapshot: {
    symbol: "BTCUSDT",
    currentPrice: 91371,
    priceChange24h: 2.5,
    analysis: { /* current market analysis */ },
    signal: { /* current signal data */ },
    htfBias: { /* HTF bias data */ }
  },
  setupType: "SCALP" | "4h" | "Swing" | "MicroScalp",
  symbol: "BTCUSDT"
}
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

**Frontend Function:**
- `analyzeTrade(tradeId)` - Analyzes active trade position

**Code Location:**
- `public/tracker.html` lines ~2350-2450
- `api/agent-review.js` (same endpoint, different context)

---

## API Endpoint

### `/api/agent-review`

**Location:** `api/agent-review.js`

**Method:** `POST`

**Request Body (Two Modes):**

#### Mode 1: Market Review (Marquee)
```javascript
{
  tradesData: {
    SAFE_MODE: { /* all symbols */ },
    AGGRESSIVE_MODE: { /* all symbols */ }
  },
  systemPrompt: "When analyzing trade JSON..."
}
```

#### Mode 2: Individual Trade Analysis (Details/Tracker)
```javascript
{
  symbol: "BTCUSDT",
  setupType: "4h" | "Swing" | "Scalp" | "MicroScalp",
  marketSnapshot: { /* symbol-specific data */ }
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
- Auto-triggered analysis runs for 3 symbols on page load

---

## System Prompts

### Prompt Structure

All prompts follow this structure:

1. **Role Definition:** "You are the Trading Reasoning Layer for EditTrades"
2. **Job Description:** What the AI should analyze
3. **Strategy-Specific Guidance:** Custom rules for each strategy type
4. **General Rules:** Constraints and formatting requirements
5. **Output Format:** How to structure the response

### Prompt Customization

**To modify prompts:**

1. **Marquee Prompt:** Edit `public/index.html` line ~2420
   ```javascript
   systemPrompt: 'When analyzing trade JSON, respond with...'
   ```

2. **Details/Tracker Prompts:** Edit `api/agent-review.js`
   - Base prompt: lines ~234-283
   - Strategy guidance: lines ~167-225
   - Analysis points: lines ~286-321

### Prompt Best Practices

1. **Be Specific:** Include exact strategy requirements
2. **Set Constraints:** Clearly state what NOT to analyze (e.g., MicroScalp ignores 4H)
3. **Define Output Format:** Specify paragraph structure, length, rating system
4. **Include Examples:** Reference actual data structure in prompts
5. **Set Tone:** Define conversational style (confident, observational, actionable)

---

## Frontend Integration

### Marquee Integration

**HTML Element:**
```html
<div id="newsMarquee">
  <div id="newsMarqueeContent">
    <!-- AI analysis displayed here -->
  </div>
</div>
```

**JavaScript Functions:**
```javascript
// Initialize on page load
startMarketReview();

// Manual refresh
getAIMarketReview();

// Update display
updateMarketReviewDisplay();
```

**Styling:**
- Scrolling marquee animation
- Yellow text (`var(--color-yellow-75)`)
- Auto-refreshes every 5 minutes

### Details Section Integration

**HTML Element:**
```html
<div id="ai-review-content-${symbol}">
  <!-- AI analysis displayed here -->
</div>
```

**JavaScript Functions:**
```javascript
// Auto-trigger for major coins
autoTriggerAIAnalysis();

// Manual trigger
getAIReview(symbol, false);

// Silent auto-trigger
getAIReview(symbol, true);
```

**Styling:**
- Displayed in details dropdown
- Loading animation during analysis
- Formatted paragraphs with rating

### Trade Tracker Integration

**HTML Element:**
```html
<div id="aiAnalysis-${trade.id}">
  <!-- AI analysis displayed here -->
</div>
<button onclick="analyzeTrade(${trade.id})">ANALYZE</button>
```

**JavaScript Functions:**
```javascript
// Analyze active trade
analyzeTrade(tradeId);
```

**Styling:**
- Displayed in trade card
- Button triggers analysis
- Only available for ACTIVE/PENDING trades

---

## Enhancement Guide

### Adding New AI Analysis Features

#### Step 1: Define Use Case
- What data will be analyzed?
- What output format is needed?
- Where will it be displayed?

#### Step 2: Create System Prompt
- Write clear role definition
- Include strategy-specific rules
- Define output format
- Set tone and style

#### Step 3: Update API Endpoint
- Add new mode handler in `api/agent-review.js`
- Or create new endpoint if needed
- Include error handling

#### Step 4: Frontend Integration
- Add HTML element for display
- Create JavaScript function to fetch analysis
- Add trigger mechanism (auto or manual)
- Style the output

#### Step 5: Test
- Test with real data
- Verify prompt produces desired output
- Check error handling
- Test rate limiting

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

#### To Use Anthropic Claude:

1. **Install SDK or use fetch:**
   ```javascript
   const response = await fetch('https://api.anthropic.com/v1/messages', {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'x-api-key': process.env.ANTHROPIC_API_KEY,
       'anthropic-version': '2023-06-01'
     },
     body: JSON.stringify({
       model: 'claude-3-haiku-20240307',
       max_tokens: 1024,
       messages: [
         { role: 'user', content: userPrompt }
       ]
     })
   });
   ```

2. **Update Environment Variable:**
   ```bash
   ANTHROPIC_API_KEY=sk-ant-...
   ```

3. **Adjust Prompts:** Claude may require different prompt structure

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
- Consider caching responses
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

#### 5. Response Too Long/Short

**Symptoms:**
- Analysis cuts off mid-sentence
- Analysis is too brief

**Solutions:**
- Adjust `max_tokens` parameter
- Modify prompt to request specific length
- Check token usage in OpenAI dashboard

### Debugging

#### Enable Detailed Logging:

The API endpoint includes extensive logging. Check:
- Browser console for frontend logs
- Vercel function logs for backend logs
- Look for `🚀 [AGENT-REVIEW]` prefixed logs

#### Test API Directly:

```bash
curl -X POST https://your-domain.vercel.app/api/agent-review \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "BTCUSDT",
    "setupType": "4h",
    "marketSnapshot": { /* test data */ }
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

---

## Best Practices

### Prompt Engineering

1. **Be Explicit:** Clearly state what to analyze and what to ignore
2. **Use Examples:** Include sample data structure in prompts
3. **Set Constraints:** Define what NOT to do (e.g., "DO NOT mention 4H for MicroScalp")
4. **Define Format:** Specify output structure (paragraphs, length, rating)
5. **Test Iteratively:** Refine prompts based on output quality

### Performance

1. **Cache Responses:** Consider caching for identical requests
2. **Batch Requests:** Group multiple analyses when possible
3. **Rate Limiting:** Add delays between requests
4. **Error Handling:** Gracefully handle API failures
5. **Fallback Content:** Show placeholder when AI unavailable

### Cost Management

1. **Use Efficient Models:** `gpt-4o-mini` is cost-effective
2. **Limit Token Usage:** Set appropriate `max_tokens`
3. **Cache Responses:** Avoid redundant API calls
4. **Monitor Usage:** Track API usage in OpenAI dashboard
5. **Optimize Prompts:** Shorter prompts = lower costs

---

## Related Documentation

- `docs/STRATEGY_IMPLEMENTATION_GUIDE.md` - Strategy details AI analyzes
- `docs/STRATEGY_MODES.md` - Mode differences AI considers
- `docs/SYSTEM_CONTEXT.md` - System architecture
- `docs/DEVELOPMENT_PROCEDURE.md` - Development workflow

---

**Last Updated:** 2025-01-27  
**Version:** 1.0.0

