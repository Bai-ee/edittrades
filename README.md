# 📊 Snapshot TradingView - 4H Strategy Automation

Professional crypto trading signal generator with serverless API deployment. Built for the "set and forget" 4-hour trading strategy with multi-timeframe confirmation.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/snapshot_tradingview)

---

## ✨ Features

### 🎯 Trading Strategy
- **4H Set & Forget System** - Automated trade signal generation
- **Multi-Timeframe Analysis** - 4h, 1h, 15m, 5m confirmation
- **Confidence Scoring** - 0-100% confidence for each setup
- **Risk Management** - Auto-calculated entry zones, stop loss, and take profit levels (1:1, 1:2 RR)

### 📈 Technical Indicators
- 21 EMA & 200 EMA trend identification
- Stochastic RSI (14,14,3) with %K and %D
- RSI with overbought/oversold detection
- Market structure (swing highs/lows, BOS/CHOCH)
- Pullback state detection
- Wick rejection analysis
- Trend strength (ADX)
- Candlestick pattern detection

### 🎯 Advanced Chart Analysis (✅ Complete TradingView-level parity)
- **Market Structure:** BOS/CHOCH detection, swing analysis, structural trend
- **Volatility:** ATR calculation with state classification (low/normal/high/extreme)
- **Volume Profile:** HVN/LVN detection, Value Area calculation
- **Liquidity Zones:** Equal highs/lows detection with strength scoring
- **Fair Value Gaps:** Bullish/bearish gap detection with fill state
- **Divergences:** RSI/StochRSI divergence detection (regular/hidden)
- **Volume Analysis:** Current volume, 20-period average, trend analysis

**All advanced modules guaranteed to exist (never null) across all timeframes.**

### 🔍 Market Scanner
- Scan 30+ curated coins or 300+ Kraken pairs
- Filter by confidence, direction (long/short)
- Ranked opportunities by confidence
- Real-time market overview

### 🚀 Deployment Options
- **Vercel Serverless** - One-click deploy (recommended)
- **Local Development** - Node.js + Express
- **Docker** - Containerized deployment (optional)

---

## 🌐 Live Demo

**Dashboard:** [https://snapshot-tradingview.vercel.app](https://snapshot-tradingview.vercel.app) *(replace with your URL)*

**API Examples:**
- Indicators: `/api/indicators/BTCUSDT?intervals=4h,1h,15m,5m`
- Strategy: `/api/analyze/BTCUSDT`
- Scanner: `/api/scan?minConfidence=0.6&maxResults=10`

---

## 🚀 Quick Start

### Option 1: Deploy to Vercel (Easiest)

1. Click the "Deploy with Vercel" button above
2. Connect your GitHub account
3. Vercel automatically deploys the app
4. Access your live dashboard!

**Full deployment guide:** [DEPLOYMENT.md](./DEPLOYMENT.md)

### Option 2: Run Locally

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/snapshot_tradingview.git
cd snapshot_tradingview

# Install dependencies
npm install

# Start development server
npm start

# Or use Vercel dev (recommended for testing serverless functions)
npm install -g vercel
vercel dev
```

Open browser to `http://localhost:3000`

---

## 📡 API Documentation

### 1. **Indicators Endpoint**

Get multi-timeframe indicator data for any symbol.

```bash
GET /api/indicators/BTCUSDT?intervals=4h,1h,15m,5m
```

**Response:**
```json
{
  "symbol": "BTCUSDT",
  "source": "kraken",
  "timeframes": {
    "4h": {
      "currentPrice": 90690.30,
      "ema21": 87927.62,
      "ema200": 97806.04,
      "stoch": { "k": 100.0, "d": 75.15, "condition": "OVERBOUGHT" },
      "pullback": { "distanceFrom21": 3.10, "state": "OVEREXTENDED" },
      "trend": "FLAT",
      "swingHigh": 90850.0,
      "swingLow": 85250.0
    }
  }
}
```

### 2. **Strategy Analysis Endpoint**

Get complete 4H strategy analysis with trade signal.

```bash
GET /api/analyze/BTCUSDT
```

**Response (Valid Trade):**
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "reason": "4h uptrend, 1h agrees, price entry zone ✅ HIGH CONFIDENCE",
  "valid": true,
  "confidence": 0.82,
  "entryZone": { "min": 87200, "max": 87600 },
  "stopLoss": 86500,
  "targets": { "tp1": 88300, "tp2": 89100 },
  "riskReward": { "tp1RR": 1.21, "tp2RR": 2.35 }
}
```

**Response (No Trade):**
```json
{
  "symbol": "BTCUSDT",
  "direction": "NO_TRADE",
  "reason": "4h trend is flat - no trade",
  "valid": false,
  "confidence": 0
}
```

### 3. **Compact Analysis Endpoint** 🤖 *NEW - LLM Optimized*

Get streamlined analysis perfect for ChatGPT/LLM ingestion. **95% smaller** than full response.

```bash
GET /api/analyze-compact/BTCUSDT
```

**Response (2KB instead of 50KB):**
```json
{
  "symbol": "BTCUSDT",
  "price": 90690.30,
  "change24h": 2.45,
  "signal": {
    "valid": true,
    "direction": "long",
    "confidence": 78,
    "reason": "4h uptrend confirmed, price near entry zone",
    "entry": { "min": 89500, "max": 90000 },
    "stopLoss": 88200,
    "targets": { "tp1": 91800, "tp2": 93600 },
    "riskReward": "1:2.31"
  },
  "timeframes": {
    "4h": {
      "trend": "UPTREND",
      "ema21": 87927.62,
      "stoch": { "zone": "OVERSOLD", "k": 25.5 },
      "pullback": "ENTRY_ZONE"
    }
  }
}
```

**📖 Full schema:** [COMPACT_SCHEMA.md](./COMPACT_SCHEMA.md)

### 4. **Market Scanner Endpoint**

Scan all coins for trading opportunities.

```bash
GET /api/scan?minConfidence=0.6&maxResults=10&direction=long
```

**Response:**
```json
{
  "summary": {
    "totalScanned": 32,
    "opportunitiesFound": 5,
    "duration": 12.5
  },
  "opportunities": [
    {
      "symbol": "ETHUSDT",
      "direction": "LONG",
      "confidence": 0.85,
      "entryZone": { "min": 3200, "max": 3250 },
      "stopLoss": 3150,
      "targets": { "tp1": 3350, "tp2": 3450 }
    }
  ]
}
```

**Full API documentation:** [DEPLOYMENT.md#api-documentation](./DEPLOYMENT.md#-api-documentation)

### 📊 Dashboard View JSON

Export your analysis in a **compact, readable format** that matches exactly what you see on screen.

- **📊 View Button** - Copies dashboard view as JSON (~2-3KB)
- **Auto-syncs** - Automatically includes new fields as we enhance the tool
- **All timeframes** - Includes 4h, 1h, 15m, 5m analysis
- **Perfect for** - Sharing analysis, documentation, trading journals

**Full documentation:** [DASHBOARD_VIEW_JSON.md](./DASHBOARD_VIEW_JSON.md)

---

## 🏗️ Architecture

### Tech Stack
- **Frontend:** Static HTML/CSS/JS with Tailwind CSS
- **Backend:** Vercel Serverless Functions (Node.js 20)
- **Data Source:** Kraken API (free, no API key required)
- **Indicators:** Custom implementation + technicalindicators library
- **Deployment:** Vercel (auto-deploy from GitHub)

### Project Structure
```
snapshot_tradingview/
├── api/                      # Vercel serverless functions
│   ├── indicators.js         # Multi-timeframe indicators
│   ├── analyze.js            # Strategy analysis
│   └── scan.js               # Market scanner
├── services/                 # Shared business logic
│   ├── marketData.js         # OHLCV data fetching
│   ├── indicators.js         # Technical indicators
│   ├── strategy.js           # 4H strategy engine
│   └── scanner.js            # Multi-coin scanner
├── public/                   # Static frontend
│   ├── index.html            # Main dashboard
│   └── scanner.html          # Market scanner UI
├── vercel.json               # Vercel configuration
├── server.js                 # Local Express server (dev)
└── package.json
```

---

## 🎨 Dashboard Features

### Main Dashboard (`/`)
- **Symbol Search** - Searchable dropdown with 300+ coins
- **Favorites** - Star your favorite trading pairs
- **4H Trade Signal Card** - Clear long/short/no-trade signals
- **Multi-Timeframe Cards** - 4h, 1h, 15m, 5m analysis
- **Live Data** - Real-time price updates

### Market Scanner (`/scanner.html`)
- **Adjustable Filters** - Confidence, direction, max results
- **Summary Stats** - Scanned, opportunities, duration
- **Sortable Table** - View all opportunities at a glance
- **One-Click Details** - Jump to full analysis

---

## 🔧 Configuration

### Supported Symbols

**Curated List (35 coins):**
- Major: BTC, ETH, SOL, BNB, ADA, XRP, DOGE, DOT, MATIC, LINK
- DeFi: AVAX, ATOM, UNI, AAVE, ALGO
- Layer 2: ARB, OP
- Meme: SHIB, PEPE
- Others: LTC, BCH, XLM, TRX, ETC, XMR, FIL, APT, NEAR, ICP, INJ, SUI, TON

**Dynamic List (300+ coins):**
- Enable with `?all=true` query parameter
- Fetches all available Kraken trading pairs

### Supported Timeframes
- 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d

---

## 📊 Strategy Logic

### 4H Trading Rules

**Long Setup:**
1. 4H trend = UPTREND (price > 200 EMA)
2. Price retracing to 21 EMA (±0.4% zone)
3. 1H not breaking down (trend ≠ DOWNTREND)
4. 15m + 5m Stoch RSI curling up
5. Entry: 21 EMA ±0.4%
6. SL: Below swing low (-0.3%)
7. TP1: 1:1 RR, TP2: 1:2 RR

**Short Setup:**
1. 4H trend = DOWNTREND (price < 200 EMA)
2. Price retracing to 21 EMA (±0.4% zone)
3. 1H showing lower highs
4. 15m + 5m Stoch RSI curling down
5. Entry: 21 EMA ±0.4%
6. SL: Above swing high (+0.3%)
7. TP1: 1:1 RR, TP2: 1:2 RR

### Confidence Scoring (0-1.0)
- **0.75+** 🟢 HIGH - 4h + 1h aligned, stoch confirming, good structure
- **0.55-0.75** 🟡 MEDIUM - Most criteria met, some divergence
- **<0.55** 🔴 LOW - Weak setup, missing confirmations

---

## 🧪 Testing

### Test API Endpoints Locally

```bash
# Start dev server
vercel dev

# Test indicators
curl "http://localhost:3000/api/indicators/BTCUSDT?intervals=4h,1h"

# Test strategy
curl "http://localhost:3000/api/analyze/BTCUSDT"

# Test scanner
curl "http://localhost:3000/api/scan?minConfidence=0.6&maxResults=5"
```

### Test on Production

```bash
# Replace with your Vercel URL
curl "https://your-project.vercel.app/api/analyze/ETHUSDT"
```

---

## 🔐 Security & Rate Limiting

- **No API Keys Required** - Uses free Kraken public API
- **CORS Enabled** - Safe for public consumption
- **Rate Limiting** - Built-in delays to respect API limits
- **No Data Storage** - Stateless, no database required

---

## 📚 Documentation

- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Complete deployment guide
- **[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)** - Common issues & solutions
- **[docs/prd.txt](./docs/prd.txt)** - Product requirements document
- **[docs/technical-data-requirements.md](./docs/technical-data-requirements.md)** - Technical specs

---

## 🤝 Use Cases

### For Traders
- Get instant 4H trade signals
- Scan markets for opportunities
- Monitor multiple timeframes
- Track favorite coins

### For Developers
- Use clean JSON APIs for trading bots
- Integrate with Discord/Telegram notifications
- Build custom dashboards
- Extend with new indicators

### For LLMs/AI
- Clean, structured JSON responses
- Clear signal reasoning
- Ready for natural language generation
- Easy integration with GPT/Claude

**Example LLM Integration:**
```javascript
const signal = await fetch('/api/analyze/BTCUSDT').then(r => r.json());
const message = `
Trade Signal: ${signal.direction}
Confidence: ${signal.confidence * 100}%
Reason: ${signal.reason}
Entry: $${signal.entryZone.min} - $${signal.entryZone.max}
Stop Loss: $${signal.stopLoss}
Take Profit: $${signal.targets.tp1} (TP1), $${signal.targets.tp2} (TP2)
`;
// Send to Discord, Telegram, SMS, etc.
```

---

## 🛠️ Development

### Local Development

```bash
# Install dependencies
npm install

# Run local server (Express)
npm start

# Run with Vercel dev (recommended)
vercel dev

# Watch mode
npm run dev
```

### Add New Indicators

Edit `services/indicators.js`:
```javascript
export function calculateMyIndicator(candles) {
  // Your indicator logic
  return result;
}
```

### Add New Symbols

Edit `services/marketData.js`:
```javascript
const SYMBOL_MAP = {
  'NEWUSDT': { kraken: 'NEWUSD', name: 'New Coin' }
};
```

---

## 🐛 Troubleshooting

**Issue: API returns 404**
- Ensure `vercel.json` is in repo root
- Check function names match in `/api` folder

**Issue: CORS errors**
- CORS headers are set in each API function
- Check browser console for details

**Issue: Timeout errors**
- Scanner can take 60+ seconds for large scans
- Increase timeout in `vercel.json` if needed

**More solutions:** [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

## 📈 Roadmap

- [ ] Add backtesting module
- [ ] WebSocket real-time updates
- [ ] More exchanges (Binance, Coinbase)
- [ ] Advanced filtering (volume, market cap)
- [ ] Email/SMS notifications
- [ ] Mobile app (React Native)
- [ ] Trading bot automation

---

## 🤝 Contributing

Contributions welcome! Please read the contribution guidelines before submitting PRs.

1. Fork the repo
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

---

## 📄 License

MIT License - feel free to use for personal or commercial projects.

---

## 🙏 Acknowledgments

- **Kraken** for free, reliable crypto data API
- **TradingView** for strategy inspiration
- **Vercel** for excellent serverless platform
- Community for testing and feedback

---

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/YOUR_USERNAME/snapshot_tradingview/issues)
- **Discussions:** [GitHub Discussions](https://github.com/YOUR_USERNAME/snapshot_tradingview/discussions)
- **Documentation:** [Full docs](./DEPLOYMENT.md)

---

**⭐ Star this repo if you find it useful!**

**💰 Happy Trading!**
