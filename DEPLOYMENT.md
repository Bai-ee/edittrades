# 🚀 Vercel Deployment Guide

This guide will help you deploy the Snapshot TradingView application to Vercel with serverless API endpoints.

## 📋 Prerequisites

- GitHub account
- Vercel account (free tier works perfectly)
- Git installed locally
- Node.js 18+ installed

## 🏗️ Architecture Overview

**Stack:**
- **Frontend:** Static HTML/CSS/JS (served from `/public`)
- **Backend:** Vercel Serverless Functions (Node.js 20)
- **Data Source:** Kraken API (free, no API key required)
- **Hosting:** Vercel (auto-deploy from GitHub)

**API Endpoints:**
- `GET /api/indicators` - Multi-timeframe indicator data
- `GET /api/analyze` - Complete strategy analysis with trade signals
- `GET /api/scan` - Market-wide opportunity scanner

---

## 🚀 Quick Deploy to Vercel

### Option 1: One-Click Deploy (Easiest)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/snapshot_tradingview)

1. Click the button above
2. Connect your GitHub account
3. Vercel will automatically:
   - Fork/clone the repo
   - Install dependencies
   - Deploy the app
   - Provide a live URL

### Option 2: Manual Deploy via GitHub

1. **Push to GitHub:**
   ```bash
   cd /Users/bballi/Documents/Repos/snapshot_tradingview
   git add .
   git commit -m "Add Vercel serverless deployment"
   git push origin main
   ```

2. **Connect to Vercel:**
   - Go to [vercel.com](https://vercel.com)
   - Click "Add New" → "Project"
   - Import your `snapshot_tradingview` repo
   - Vercel auto-detects settings from `vercel.json`
   - Click "Deploy"

3. **Done!** Your app is live at `https://your-project.vercel.app`

### Option 3: Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Login to Vercel
vercel login

# Deploy
cd /Users/bballi/Documents/Repos/snapshot_tradingview
vercel

# Deploy to production
vercel --prod
```

---

## 🧪 Local Development

### Run with Vercel Dev (Recommended)

```bash
# Install Vercel CLI
npm install -g vercel

# Start dev server (simulates Vercel environment)
vercel dev
```

This starts:
- Frontend at `http://localhost:3000`
- Serverless functions at `/api/*`
- Hot reload on file changes

### Run with Node.js (Legacy)

```bash
# Start Express server (for backward compatibility)
npm start
```

This runs the original `server.js` on port 3000.

---

## 📡 API Documentation

### 1. Indicators Endpoint

**Get multi-timeframe indicator data for a symbol**

```bash
GET /api/indicators/BTCUSDT?intervals=4h,1h,15m,5m
GET /api/indicators?symbol=BTCUSDT&intervals=4h,1h,15m,5m
```

**Response Example:**
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
      "swingLow": 85250.0,
      "candleCount": 500
    },
    "1h": { ... },
    "15m": { ... },
    "5m": { ... }
  },
  "timestamp": "2025-11-26T18:30:00.000Z"
}
```

### 2. Strategy Analysis Endpoint

**Get complete 4H strategy analysis with trade signal**

```bash
GET /api/analyze/BTCUSDT?intervals=4h,1h,15m,5m
GET /api/analyze?symbol=BTCUSDT&intervals=4h,1h,15m,5m
```

**Response Example (Valid Trade):**
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "reason": "4h uptrend, 1h agrees, price entry zone, lower TF stoch up/up ✅ HIGH CONFIDENCE",
  "valid": true,
  "confidence": 0.82,
  "currentPrice": 87450.00,
  "priceChange24h": 2.45,
  "entryZone": { "min": 87200, "max": 87600 },
  "stopLoss": 86500,
  "targets": { "tp1": 88300, "tp2": 89100 },
  "riskReward": { "tp1RR": 1.21, "tp2RR": 2.35 },
  "levels": { "ema21": 87400, "ema200": 85200 },
  "timeframes": {
    "4h": { 
      "trend": "UPTREND",
      "stoch": { "k": 65.5, "d": 58.2, "condition": "BULLISH" },
      "pullbackState": "ENTRY_ZONE"
    },
    "1h": { "trend": "UPTREND", ... },
    "15m": { "trend": "FLAT", ... },
    "5m": { "trend": "UPTREND", ... }
  },
  "timestamp": "2025-11-26T18:30:00.000Z"
}
```

**Response Example (No Trade):**
```json
{
  "symbol": "BTCUSDT",
  "direction": "NO_TRADE",
  "reason": "4h trend is flat - no trade",
  "valid": false,
  "confidence": 0,
  "currentPrice": 90690.30,
  "priceChange24h": -0.85,
  "timeframes": { ... },
  "timestamp": "2025-11-26T18:30:00.000Z"
}
```

### 3. Market Scanner Endpoint

**Scan all coins for trading opportunities**

```bash
GET /api/scan?minConfidence=0.6&maxResults=25&direction=long
GET /api/scan?minConfidence=0.5&maxResults=50&all=true
```

**Query Parameters:**
- `minConfidence` - Min confidence score (0-1), default: 0.5
- `maxResults` - Max results to return, default: 50
- `direction` - Filter: 'long' or 'short' (optional)
- `intervals` - Timeframes (default: 4h,1h,15m,5m)
- `all` - If 'true', scan ALL Kraken pairs (300+) instead of curated list

**Response Example:**
```json
{
  "summary": {
    "totalScanned": 32,
    "opportunitiesFound": 5,
    "errors": 0,
    "noSetup": 25,
    "lowConfidence": 2,
    "duration": 12.5,
    "timestamp": "2025-11-26T18:30:00.000Z",
    "filteredCount": 5
  },
  "opportunities": [
    {
      "symbol": "ETHUSDT",
      "direction": "LONG",
      "confidence": 0.85,
      "entryZone": { "min": 3200, "max": 3250 },
      "stopLoss": 3150,
      "targets": { "tp1": 3350, "tp2": 3450 },
      "currentPrice": 3225.50,
      "priceChange24h": 3.25,
      "reason": "4h uptrend, 1h agrees, price entry zone ✅ HIGH CONFIDENCE",
      "trend": { "4h": "uptrend", "1h": "uptrend" },
      "timestamp": "2025-11-26T18:30:00.000Z"
    },
    ...
  ]
}
```

---

## ⚙️ Configuration

### Environment Variables (Optional)

While the app works without any environment variables (uses free Kraken API), you can optionally add:

```bash
# In Vercel Dashboard → Settings → Environment Variables
NODE_ENV=production
```

### Vercel Settings

The `vercel.json` file configures:
- **Runtime:** Node.js 20
- **Function Timeout:** 60 seconds (for market scanner)
- **CORS:** Enabled for all API routes
- **Rewrites:** Path-based routing for clean URLs

---

## 🔧 Troubleshooting

### Issue: API Returns 404

**Solution:** Make sure `vercel.json` is in the repo root and properly configured.

### Issue: API Timeout

**Solution:** Increase function timeout in `vercel.json`:
```json
{
  "functions": {
    "api/**/*.js": {
      "maxDuration": 60
    }
  }
}
```

### Issue: CORS Errors

**Solution:** CORS headers are configured in each API function. If issues persist, check browser console and verify the `Access-Control-Allow-Origin` header is present.

### Issue: Module Import Errors

**Solution:** Ensure `package.json` has `"type": "module"` for ES6 imports:
```json
{
  "type": "module"
}
```

---

## 📊 Monitoring & Analytics

### View Logs

```bash
# Real-time logs
vercel logs YOUR_PROJECT_URL

# Function logs in Vercel Dashboard
# Go to: Dashboard → Your Project → Functions → Select function
```

### Performance

- **Cold Start:** ~1-2 seconds
- **Warm Response:** ~200-500ms
- **Scanner (35 coins):** ~12-15 seconds
- **Scanner (300+ coins):** ~60-90 seconds

---

## 🌐 Custom Domain

1. Go to Vercel Dashboard → Your Project → Settings → Domains
2. Add your domain (e.g., `tradingview.yourdomain.com`)
3. Follow DNS configuration instructions
4. SSL is automatic via Vercel

---

## 🔄 Auto-Deploy on Push

Once connected to GitHub, Vercel automatically:
- Deploys on every `git push` to `main`
- Creates preview deployments for PRs
- Runs builds and shows deployment status

**Disable auto-deploy:**
```bash
# In Vercel Dashboard
Settings → Git → Auto-deploy: OFF
```

---

## 📱 Access Your App

After deployment:

- **Dashboard:** `https://your-project.vercel.app/`
- **Scanner:** `https://your-project.vercel.app/scanner.html`
- **API Indicators:** `https://your-project.vercel.app/api/indicators/BTCUSDT`
- **API Analyze:** `https://your-project.vercel.app/api/analyze/BTCUSDT`
- **API Scanner:** `https://your-project.vercel.app/api/scan?minConfidence=0.6`

---

## 🎯 Next Steps

1. ✅ Deploy to Vercel
2. ✅ Test API endpoints
3. ✅ Connect custom domain (optional)
4. 🔄 Set up monitoring/alerts
5. 📈 Integrate with trading bots or notification systems

---

## 💡 Pro Tips

1. **Use Preview Deployments:** Test changes in isolated preview URLs before merging to main
2. **Monitor Function Usage:** Free tier includes 100GB-hours/month (plenty for this app)
3. **Cache API Responses:** Consider adding Redis/KV cache for frequently accessed data
4. **Rate Limiting:** Add rate limiting to prevent API abuse
5. **Webhooks:** Set up Vercel webhooks to trigger actions on deployments

---

## 📚 Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Vercel Serverless Functions](https://vercel.com/docs/concepts/functions/serverless-functions)
- [Kraken API Docs](https://docs.kraken.com/rest/)

---

**Need help?** Check the [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) guide or open an issue on GitHub.

