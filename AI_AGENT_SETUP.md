# EditTrades AI Reasoning Agent Setup

## Overview

The AI Reasoning Agent provides intelligent trade analysis on top of the EditTrades rule engine. It evaluates market data, applies higher-level reasoning, and generates human-readable trade calls with confluence analysis.

---

## Features

✅ **Analyzes JSON market data** (same data exported by "COPY GPT" button)  
✅ **Strategy-specific analysis** (4H, Swing, Scalp, Micro-Scalp)  
✅ **Priority ratings** (A+, A, B, SKIP)  
✅ **Formatted trade calls** with reasoning  
✅ **No database required** - stateless API calls  
✅ **Dynamic updates** when switching strategies  

---

## Setup Instructions

### 1. Get Your OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Create a new API key
3. Copy the key (starts with `sk-proj-...`)

### 2. Configure Environment Variable

#### **For Vercel (Production)**

1. Go to your Vercel project dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Add a new variable:
   - **Name**: `OPENAI_API_KEY`
   - **Value**: Your OpenAI API key
   - **Environment**: Production, Preview, Development (select all)
4. Click **Save**
5. Redeploy your project for changes to take effect

#### **For Local Development**

1. Create a `.env` file in the root directory:

```bash
OPENAI_API_KEY=sk-proj-your-key-here
```

2. The key will be automatically loaded by Vercel dev server

**Note:** Never commit your `.env` file to Git!

---

## How It Works

### User Flow

1. User clicks on a coin row to expand details
2. User sees "AI REASONING AGENT" section with "GET AI REVIEW" button
3. User clicks button → AI analyzes the market data
4. AI returns:
   - Priority rating (A+, A, B, or SKIP)
   - Formatted trade call
   - Confluence analysis
   - Entry/Stop/Target validation
   - Key observations

5. User can switch strategies (4H → Swing → Scalp) and get new AI analysis for each

### Technical Flow

```
Frontend (index.html)
    ↓
    Calls createDashboardView(data)
    ↓
    Sends JSON to /api/agent-review
    ↓
Backend (api/agent-review.js)
    ↓
    Formats prompt with market data
    ↓
    Calls OpenAI GPT-4o-mini
    ↓
    Returns formatted trade analysis
    ↓
Frontend displays result
```

---

## API Endpoint

### `POST /api/agent-review`

**Request Body:**
```json
{
  "symbol": "BTCUSDT",
  "setupType": "Swing",
  "marketSnapshot": {
    "symbol": "BTCUSDT",
    "price": 91121.7,
    "change24h": 0.65,
    "signal": { ... },
    "timeframes": { ... },
    "timestamp": "2025-11-28T..."
  }
}
```

**Response:**
```json
{
  "success": true,
  "symbol": "BTCUSDT",
  "setupType": "Swing",
  "priority": "A+",
  "formattedText": "BTCUSDT — LONG (SWING)\n\nConfidence: 85%\n...",
  "timestamp": "2025-11-28T..."
}
```

---

## Agent Capabilities

The AI agent:

### ✅ DOES:
- Validates setup quality against strategy rules
- Adds confluence reasoning (HTF alignment, momentum, structure)
- Identifies red flags (trend exhaustion, conflicting signals)
- Rates trade priority (A+, A, B, SKIP)
- Generates formatted trade calls in your preferred format
- Provides actionable insights beyond raw indicators

### ❌ DOES NOT:
- Override numerical values (entry, stop, targets)
- Store or remember previous analysis (stateless)
- Make trades automatically
- Require a database

---

## Costs

**OpenAI API Pricing (GPT-4o-mini):**
- Input: $0.15 / 1M tokens
- Output: $0.60 / 1M tokens

**Estimated cost per analysis:**
- ~$0.001 - $0.003 per request
- ~$1 for 500-1000 AI reviews

Very affordable for occasional use! 💰

---

## Troubleshooting

### "AI Review Failed" Error

**Possible causes:**

1. **API key not set**
   - Check Vercel environment variables
   - Ensure key is saved in correct environment

2. **Invalid API key**
   - Key may be expired or revoked
   - Generate a new key from OpenAI dashboard

3. **Rate limit exceeded**
   - OpenAI free tier has usage limits
   - Upgrade to paid tier or wait for reset

4. **Network error**
   - Check internet connection
   - Verify Vercel functions are working

### Check Logs

**Vercel:**
- Go to your project → **Deployments** → Select latest → **Functions** tab
- View logs for `/api/agent-review`

**Local:**
- Check terminal output where `npm start` is running
- Look for "Agent review error" messages

---

## Customization

### Change AI Model

In `api/agent-review.js`, line 87:

```javascript
model: 'gpt-4o-mini',  // Change to 'gpt-4o', 'gpt-4-turbo', etc.
```

### Adjust Temperature (Creativity)

In `api/agent-review.js`, line 93:

```javascript
temperature: 0.3,  // 0 = deterministic, 1 = creative
```

### Modify System Prompt

Edit the `systemPrompt` variable in `api/agent-review.js` to change:
- Trade call formatting
- Analysis focus areas
- Priority rating criteria

---

## Example AI Output

```
BTCUSDT — LONG (SWING)

Confidence: 85%
Direction: 🟢⬆️ Long
Setup Type: Swing

ENTRY:
$90,500 – $91,000

STOP LOSS:
$89,800

TARGETS:
TP1: $95,000
TP2: $98,500
TP3: $102,000

RISK / REWARD:
3R to 5R targets

INVALIDATION:
Close below $89,800 (3D/1D swing level)

WHY THIS TRADE:
– 3D stoch oversold pivot completed
– 1D reclaim of key level confirmed
– 4H trend supportive (UPTREND)
– Price in clean ENTRY_ZONE on LTF
– Strong HTF confluence

CONDITIONS REQUIRED:
– 3D must close bullish above reclaim
– 4H pullback must remain in ENTRY_ZONE
– 1H stoch should confirm bullish momentum

AGENT ANALYSIS:
This is a high-quality 3D Swing setup with excellent HTF
alignment. All key timeframes are in agreement, stochastic
momentum is properly positioned, and entry zone is clean.
The only minor concern is current market volatility, but
the R:R justifies the risk.

Priority: A+
```

---

## Security Notes

🔒 **Keep your API key secure!**

- ✅ Store in environment variables (not in code)
- ✅ Use Vercel's encrypted environment variable storage
- ✅ Rotate keys periodically
- ❌ Never commit `.env` files to Git
- ❌ Never share keys publicly

---

## Support

For issues or questions:
1. Check Vercel function logs
2. Verify OpenAI API key is active
3. Review this documentation
4. Check OpenAI API status: https://status.openai.com/

---

**🎉 You're all set! Click "GET AI REVIEW" on any coin to start receiving intelligent trade analysis.**

