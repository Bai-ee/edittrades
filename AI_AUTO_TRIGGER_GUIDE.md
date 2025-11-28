# AI Auto-Trigger System Guide

## 🤖 Automatic AI Analysis

The AI Reasoning Agent now automatically analyzes major coins without requiring manual clicks.

---

## ✅ When AI Auto-Analysis Runs

### 1. **Page Load** (Initial Visit)
```
User visits homepage
    ↓
BTC, ETH, SOL + starred coins are scanned
    ↓
AI analyzes BTC, ETH, SOL automatically (4H strategy)
    ↓
Results stored in background
    ↓
User can click "GET AI REVIEW" to view
```

### 2. **Refresh Button Click**
```
User clicks refresh icon
    ↓
Re-scans all coins
    ↓
AI re-analyzes BTC, ETH, SOL automatically
    ↓
Fresh AI reviews ready
```

### 3. **Strategy Button Click** (EditTrades)
```
User clicks "EditTrades" to cycle strategy
    ↓
Switches to Swing / Scalp / 4H
    ↓
AI automatically re-analyzes for that strategy
    ↓
Silent background update
```

---

## 🎯 Which Coins Get Auto-Analyzed?

| Coin Type | Scanned? | AI Auto-Analyzed? |
|-----------|----------|-------------------|
| BTC (BTCUSDT) | ✅ Always | ✅ Yes |
| ETH (ETHUSDT) | ✅ Always | ✅ Yes |
| SOL (SOLUSDT) | ✅ Always | ✅ Yes |
| Starred Coins | ✅ Yes | ❌ No (manual only) |

**Why?** 
- Major coins (BTC/ETH/SOL) are the primary focus
- Starred coins are custom additions (user decides when to analyze)
- Prevents excessive API usage for rarely-watched coins

---

## 📊 How It Works

### Silent Mode (Auto-Trigger)
When AI runs automatically:
- No loading spinner on button
- No "ANALYZING..." text
- Runs in background
- Results stored silently
- Ready when user clicks "GET AI REVIEW"

### Manual Mode (Button Click)
When user clicks "GET AI REVIEW":
- Button shows "⏳ ANALYZING..."
- Loading indicator appears
- Results display immediately

---

## 🔄 Data Flow

```
┌─────────────────────────────────────────────────────────┐
│  PAGE LOAD / REFRESH                                    │
└────────────┬────────────────────────────────────────────┘
             │
             ▼
    ┌────────────────────┐
    │  scanMajorCoins()  │ ← Fetch market data
    └────────────────────┘
             │
             ▼
    ┌─────────────────────────┐
    │  autoTriggerAIAnalysis()│ ← Auto-analyze BTC/ETH/SOL
    └─────────────────────────┘
             │
             ├─► BTC: /api/agent-review (4H)
             ├─► ETH: /api/agent-review (4H)
             └─► SOL: /api/agent-review (4H)
             │
             ▼
    ┌────────────────────────┐
    │  Store in scanResults  │ ← aiReviews: { "4h": {...} }
    └────────────────────────┘
             │
             ▼
    ┌────────────────────────┐
    │  Ready for JSON export │ ← COPY GPT includes AI data
    └────────────────────────┘
```

---

## 📋 COPY GPT JSON Structure

When you click **"COPY GPT"**, the JSON now includes AI reviews:

```json
{
  "symbol": "BTCUSDT",
  "price": 91121.7,
  "signal": { ... },
  "timeframes": { ... },
  "aiReviews": {
    "4h": {
      "priority": "SKIP",
      "formattedText": "BTCUSDT — NO TRADE (4h)\n\nConfidence: 0%...",
      "timestamp": "2025-11-28T03:08:02.760Z"
    },
    "Swing": {
      "priority": "B",
      "formattedText": "BTCUSDT — LONG (SWING)\n\nConfidence: 75%...",
      "timestamp": "2025-11-28T03:10:15.123Z"
    }
  }
}
```

**Note:** AI reviews are stored per strategy type. If you cycle through all 3 strategies, you'll have 3 AI reviews in the JSON.

---

## ⚡ Performance & Cost

### API Calls per Page Load
- Market data: 3 calls (BTC, ETH, SOL)
- AI reviews: 3 calls (BTC, ETH, SOL)
- **Total: 6 API calls** (~$0.003-0.009 per page load)

### Refresh Button
- Same as page load: 6 API calls

### Strategy Change
- 1 AI call per change (silent background)

### Starred Coins
- No automatic AI calls (manual only)

---

## 🎛️ User Control

Users can still:
- ✅ Click "GET AI REVIEW" anytime to re-analyze
- ✅ Cycle strategies to get fresh AI perspectives
- ✅ Expand details to see full AI analysis
- ✅ Copy AI reviews with "COPY GPT" button
- ✅ Star additional coins (no auto-AI on these)

---

## 🔒 Error Handling

If auto-AI fails:
- Silent failure (no user notification)
- User can manually click "GET AI REVIEW"
- Logs error to console for debugging
- Continues with remaining coins

---

## 🧪 Testing Checklist

- [ ] Visit homepage → BTC/ETH/SOL load → AI runs silently
- [ ] Click refresh → AI re-analyzes all 3 coins
- [ ] Click "EditTrades" → AI updates for new strategy
- [ ] Click "GET AI REVIEW" → Shows cached result instantly
- [ ] Click "COPY GPT" → JSON includes aiReviews
- [ ] Star a coin → Does NOT auto-analyze
- [ ] Manually analyze starred coin → Works normally

---

## 📈 Benefits

1. **Instant Insights** - AI analysis ready on page load
2. **Fresh Data** - Refresh button gets latest AI recommendations
3. **Multi-Strategy Views** - AI adapts to strategy changes
4. **Cost Efficient** - Only analyzes major coins automatically
5. **User Control** - Can still manually analyze any coin
6. **JSON Export** - AI reviews included for external use

---

## 🚀 Live Now

✅ Deployed to production
✅ Auto-AI active for BTC, ETH, SOL
✅ Refresh triggers new AI analysis
✅ Strategy changes update AI automatically

**Test it:** https://snapshottradingview-ggr7v5xbw-baiees-projects.vercel.app

---

## 🛠️ Developer Notes

### Key Functions
- `autoTriggerAIAnalysis()` - Auto-analyzes major coins only
- `getAIReview(symbol, isAutoTrigger)` - Main AI call function
- `createDashboardView()` - Includes aiReviews in JSON export

### Storage
- AI reviews stored in: `scanResults[symbol].aiReviews[setupType]`
- Persists across strategy changes
- Exported with COPY GPT button

### Silent Mode
- `isAutoTrigger = true` skips UI updates
- No button state changes
- No loading indicators
- Background only

---

*Last Updated: 2025-11-28*

