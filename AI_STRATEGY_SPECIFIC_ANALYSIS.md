# AI Strategy-Specific Analysis Update

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## 🎯 **What Changed**

The AI Reasoning Agent now provides **strategy-specific analysis** for each trade type (Swing, Scalp, 4H) and includes a **"WHAT TO WATCH FOR"** section that tells you exactly what needs to happen for that strategy to become valid.

---

## 🔄 **How It Works**

### When You Cycle Through Strategies:

```
User clicks "EditTrades" button:
  → Cycles: 4H → Swing → Scalp → 4H
  
For EACH strategy, AI provides:
  ✅ Strategy-specific evaluation
  ✅ Why this IS or ISN'T a good [SWING/SCALP/4H] trade
  ✅ Conditions required for THIS strategy
  ✅ WHAT TO WATCH FOR to make it valid
```

---

## 📋 **Strategy-Specific Analysis**

### 1. **SWING TRADE ANALYSIS**

AI evaluates:
- ✅ 3D timeframe pivot quality (truly oversold/overbought?)
- ✅ 1D reclaim/rejection strength
- ✅ 4H structural support (is 4H clear, NOT FLAT?)
- ✅ HTF invalidation levels (3D/1D swing integrity)
- ✅ Is this a clean HTF swing with 3R+ potential?

**Focus:** Multi-timeframe alignment, macro trend integrity, HTF stops

---

### 2. **SCALP TRADE ANALYSIS**

AI evaluates:
- ✅ 4H trend clarity (must be clear, NOT FLAT)
- ✅ 1H alignment with 4H direction
- ✅ 15m and 5m entry zone quality (both near 21 EMA?)
- ✅ LTF stoch momentum alignment
- ✅ Is this a clean LTF scalp with tight confluence?

**Focus:** LTF momentum quality, tight confluence, clean entry zone

---

### 3. **4-HOUR TRADE ANALYSIS**

AI evaluates:
- ✅ 4H trend clarity (UPTREND/DOWNTREND vs FLAT)
- ✅ 1H alignment with 4H
- ✅ Price position relative to 4H 21 EMA (±1%?)
- ✅ 4H stoch curl quality
- ✅ 4H pullback state validity

**Focus:** 4H trend clarity, EMA alignment, stoch momentum

---

## 📊 **NEW: "WHAT TO WATCH FOR" Section**

Every AI analysis now includes:

### 1. **Timeframes to Monitor**
```
Example:
"Watch 4H for trend to break from FLAT and establish clear UPTREND"
"Monitor 1H for alignment with 4H direction"
```

### 2. **Specific Price Levels**
```
Example:
"Watch for price to pull back to $90,500 (4H 21 EMA)"
"Monitor price action at $91,250 - if it breaks above, invalidates short setup"
```

### 3. **Conditions Needed**
```
Example:
"1H stoch needs to curl up from oversold zone"
"4H needs to break above $91,000 and hold"
"Price needs to reclaim $90,750 and close above it"
```

### 4. **Timeline Estimates**
```
Example:
"May take 4-8 hours for 4H to establish clear direction"
"Could happen within next 1-2 candles on 1H"
"Swing setups typically take 12-24 hours to materialize"
```

### 5. **Indicators to Monitor**
```
Example:
"Wait for 15m stoch to curl up from <20"
"Watch for 4H to close above 21 EMA"
"Monitor for 1D reclaim of $91,500 level"
```

---

## 🧪 **Example AI Response**

### Scenario: NO TRADE on 4H Strategy

```
BITCOIN — NO TRADE (4H)

Confidence: 0%
Direction: ⚪
Setup Type: 4H

ENTRY: N/A
STOP LOSS: N/A
TARGETS: N/A

INVALIDATION:
Currently no valid setup. Trade becomes invalid if 4H 
remains FLAT or price moves >2% from 21 EMA.

WHY THIS 4H TRADE:
– 4H trend is FLAT (blocking condition)
– 1H is UPTREND but lacks HTF support
– Stoch is OVERBOUGHT on 4H
– Price is extended from 21 EMA (+2.45%)

CONDITIONS REQUIRED FOR 4H:
– 4H trend must show clear direction
– 1H must align with 4H
– Price must be near 4H 21 EMA (±1%)
– 4H stoch must curl in direction

WHAT TO WATCH FOR (To Make This Trade Valid):
───────────────────────────────────────────────
Timeframes:
• Watch 4H candle closes - need 2-3 consecutive 
  closes in same direction to establish trend
• Monitor 1H for continued momentum

Price Levels:
• $90,500 - 4H 21 EMA (ideal pullback zone)
• $91,250 - 4H swing high (resistance)
• $89,800 - 4H swing low (support)

Conditions Needed:
• 4H needs to break above $91,250 and hold for 
  UPTREND confirmation
• OR break below $89,800 for DOWNTREND
• Then wait for pullback to 21 EMA (~$90,500)
• 4H stoch needs to reset from overbought

Timeline:
• 4-12 hours for 4H to establish direction
• Then 4-8 hours for pullback to entry zone
• Total: 8-20 hours before valid 4H setup

AGENT ANALYSIS:
This is NOT currently a valid 4H trade. The primary 
blocker is the FLAT 4H trend. For 4H strategy, you 
need clear directional bias on the 4H timeframe.

Watch the levels above - if price breaks $91,250 
with volume and holds, that signals UPTREND. Then 
wait for pullback to $90,500 area for entry.

Patience required here. Don't force a trade.

Rating: SKIP (until 4H establishes direction)
───────────────────────────────────────────────
```

---

## 🎯 **Benefits**

### 1. **Actionable Information**
- Know exactly what to watch
- Specific price levels to monitor
- Clear conditions that validate trade

### 2. **Strategy-Specific Guidance**
- Swing analysis focuses on HTF
- Scalp analysis focuses on LTF
- 4H analysis focuses on core timeframe

### 3. **Timeline Awareness**
- Understand how long setups take
- Manage expectations
- Plan monitoring schedule

### 4. **Educational Value**
- Learn what makes each strategy valid
- Understand timeframe relationships
- Improve pattern recognition

---

## 🔄 **User Experience Flow**

```
1. User expands coin (e.g., BITCOIN)
   ↓
2. AI section appears at TOP
   ↓
3. Shows analysis for current strategy (default: 4H)
   ↓
4. User clicks "EditTrades" → cycles to SWING
   ↓
5. AI section updates (3-5 seconds)
   ↓
6. New analysis appears:
   • Swing-specific evaluation
   • What Swing strategy needs
   • What to watch for Swing setup
   ↓
7. User cycles to SCALP
   ↓
8. AI updates again with Scalp-specific analysis
```

---

## 📱 **Testing Locally**

### Visit: `http://localhost:3000`

### Test Flow:
1. **Click BITCOIN** → expand details
2. **See AI analysis** at top (default: 4H)
3. **Click "EditTrades"** → cycles to Swing
4. **Watch AI update** (loading spinner → new analysis)
5. **Read "WHAT TO WATCH FOR"** section
6. **Click "EditTrades"** again → cycles to Scalp
7. **Compare analyses** - notice strategy-specific guidance

---

## 🎨 **AI Response Structure**

Each AI analysis now includes:

```
1. Trade Call Header
   • Symbol, Direction, Setup Type
   
2. Key Metrics
   • Confidence, Entry, Stop, Targets
   
3. Strategy Requirements
   • Why this IS/ISN'T good for THIS strategy
   • Conditions required for THIS strategy
   
4. ⭐ WHAT TO WATCH FOR ⭐ (NEW)
   • Timeframes to monitor
   • Price levels to watch
   • Conditions needed
   • Timeline estimates
   • Indicators to track
   
5. Agent Analysis
   • Overall quality rating
   • Specific reasoning
   • Critical assessment
```

---

## 🔧 **Technical Implementation**

### API Changes (`api/agent-review.js`):

1. **Strategy-Specific System Prompts**
   - Swing: Focus on 3D/1D/4H alignment, HTF stops, 3R+ targets
   - Scalp: Focus on 4H clarity, LTF confluence, tight stops
   - 4H: Focus on 4H trend, EMA alignment, stoch momentum
   - MicroScalp: Focus on FLAT 4H, mean-reversion, tight execution

2. **Strategy-Specific Analysis Points**
   - Custom evaluation criteria per strategy
   - Tailored to what matters for each trade type

3. **"WHAT TO WATCH FOR" Requirement**
   - Explicitly requested in AI prompt
   - Must include timeframes, levels, conditions, timeline
   - Mandatory section for all responses

---

## 📊 **Strategy Comparison**

| Strategy | Primary TF | Stop Level | Target R | Hold Time | AI Focus |
|----------|-----------|------------|----------|-----------|----------|
| **Swing** | 3D/1D/4H | 3D/1D swing | 3R-5R | Days-Weeks | HTF alignment |
| **4H** | 4H/1H | 4H swing | 1R-2R | Hours-Day | 4H clarity |
| **Scalp** | 15m/5m | 5m/15m swing | 1.5R-3R | Minutes-Hours | LTF confluence |
| **MicroScalp** | 15m/5m | 15m/5m swing | 1R-1.5R | Minutes | Mean reversion |

---

## ✅ **Complete**

All changes are:
- ✅ Live locally at **http://localhost:3000**
- ✅ Strategy-specific AI analysis
- ✅ "WHAT TO WATCH FOR" section included
- ✅ Auto-updates when user changes strategies
- ✅ Ready for testing
- ⏸️ **NOT deployed** (local testing only)

---

## 🎯 **Summary**

The AI now:
1. ✅ Analyzes each strategy specifically
2. ✅ Explains why it IS or ISN'T a good [SWING/SCALP/4H] trade
3. ✅ Tells you what timeframes to watch
4. ✅ Gives specific price levels to monitor
5. ✅ Lists conditions needed for validity
6. ✅ Provides timeline estimates
7. ✅ Updates automatically when you cycle strategies

**Test it now at http://localhost:3000!** 🚀

---

*Last Updated: 2025-11-28*  
*Status: Local testing - strategy-specific AI analysis with monitoring guidance*

