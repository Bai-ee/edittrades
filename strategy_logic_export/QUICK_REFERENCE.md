# Trade Signal Logic - Quick Reference Card

## 📦 Files at a Glance

| File | Purpose | Key Function |
|------|---------|--------------|
| **services/strategy.js** | Main 4H strategy | `evaluateStrategy()` |
| **api/analyze.js** | Trade signal endpoint | `/api/analyze/:symbol` |
| **api/indicators.js** | Technical indicators | `/api/indicators` |
| **services/marketData.js** | Data provider | `getOHLCV()` |
| **frontend_template_logic.js** | Template evaluation | `evaluateTemplateSignal()` |
| **lib/candleFeatures.js** | Candle analysis | Pattern detection |
| **lib/levels.js** | Support/Resistance | Swing-based levels |
| **lib/volumeAnalysis.js** | Volume metrics | Trend analysis |
| **lib/confluenceScoring.js** | Multi-factor score | Confluence rating |

## 🎯 3 Trading Templates

### 4H Template
- **Timeframes:** 4h → 1h → 15m/5m
- **Confidence:** ≥70%
- **RR:** 1:1, 1:2
- **Use Case:** Daily set-and-forget trades

### Swing Template  
- **Timeframes:** 1d/4h → 1h → 15m
- **Confidence:** ≥75%
- **RR:** 2:1, 3:1
- **Use Case:** Multi-day position trades

### Scalp Template
- **Timeframes:** 1h/15m → 15m → 5m
- **Confidence:** ≥65%
- **RR:** 1:1, 1.5:1
- **Use Case:** Intraday quick trades

## 📊 Key Indicators Used

| Indicator | Purpose |
|-----------|---------|
| **21 EMA** | Entry zone (mean reversion) |
| **200 EMA** | Long-term trend filter |
| **Stochastic RSI** | Momentum & overbought/oversold |
| **Swing High/Low** | Stop loss placement |
| **VWAP** | Intraday bias & fair value |
| **Bollinger Bands** | Volatility & extremes |
| **ATR** | Position sizing & volatility |
| **Volume** | Confirmation & trend strength |

## ✅ Entry Requirements (4H Strategy)

```
[✓] 4H Trend = UPTREND or DOWNTREND
[✓] 1H Trend = Same as 4H
[✓] Price Distance to 21 EMA < 3%
[✓] Stoch RSI Aligned
[✓] Clear Swing Low (LONG) or High (SHORT)
[✓] Risk/Reward ≥ 1:1
```

## 🔴 Exit Rules

**Stop Loss:**  
- LONG: Below swing low
- SHORT: Above swing high

**Take Profit:**
- TP1: 1:1 RR (move SL to breakeven)
- TP2: 2:1 RR (trail stop)

## 📡 API Quick Test

```bash
# Get full analysis
curl https://your-app.vercel.app/api/analyze/BTCUSDT

# Get indicators only
curl https://your-app.vercel.app/api/indicators?symbol=ETHUSDT&intervals=4h,1h

# Response format
{
  "tradeSignal": {
    "valid": true/false,
    "direction": "long"/"short"/"NO_TRADE",
    "confidence": 0.0-1.0,
    "entryZone": { "min": X, "max": Y },
    "stopLoss": Z,
    "targets": { "tp1": A, "tp2": B }
  }
}
```

## 🧮 Confidence Scoring

| Factor | Points |
|--------|--------|
| Base | 0.5 |
| Timeframe alignment | +0.2 |
| Near 21 EMA (<2%) | +0.15 |
| Stoch RSI curl | +0.1 |
| Volume confirmation | +0.05 |
| **Total** | **0.0-1.0** |

## 🎨 Signal States

| State | Color | Meaning |
|-------|-------|---------|
| **LONG** | 🟢 Green | Buy signal |
| **SHORT** | 🔴 Red | Sell signal |
| **NO TRADE** | ⚪ Gray | No setup |
| **4 HOUR** | 🟡 Yellow | Active strategy |

## 📁 Where to Find What

**Need to modify entry logic?**  
→ `services/strategy.js` line ~150-200

**Need to add a new indicator?**  
→ `api/indicators.js` line ~100-300

**Need to change confidence thresholds?**  
→ `frontend_template_logic.js` line ~8-45

**Need to update data source?**  
→ `services/marketData.js` line ~50-150

**Need to add candle patterns?**  
→ `lib/candleFeatures.js` line ~20-100

---

**Quick Start:** Read `README.md` for full documentation  
**Questions?** Check inline comments in each file  
**Deploy?** Copy files back to main repo and push to GitHub

