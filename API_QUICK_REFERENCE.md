# 📡 API Quick Reference

## Base URLs

- **Local:** `http://localhost:3000`
- **Production:** `https://your-project.vercel.app`

---

## Endpoints

### 1. Indicators

**Get multi-timeframe indicator data**

```bash
GET /api/indicators/BTCUSDT?intervals=4h,1h,15m,5m
GET /api/indicators?symbol=BTCUSDT&intervals=4h,1h,15m,5m
```

**Returns:** `{ symbol, source, timeframes: { 4h: {...}, 1h: {...} }, timestamp }`

---

### 2. Strategy Analysis

**Get complete 4H strategy signal**

```bash
GET /api/analyze/BTCUSDT?intervals=4h,1h,15m,5m
GET /api/analyze?symbol=BTCUSDT&intervals=4h,1h,15m,5m
```

**Returns:** 
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG" | "SHORT" | "NO_TRADE",
  "valid": true | false,
  "confidence": 0.0-1.0,
  "entryZone": { "min": 87200, "max": 87600 },
  "stopLoss": 86500,
  "targets": { "tp1": 88300, "tp2": 89100 },
  "riskReward": { "tp1RR": 1.21, "tp2RR": 2.35 }
}
```

---

### 3. Market Scanner

**Scan all coins for opportunities**

```bash
GET /api/scan?minConfidence=0.6&maxResults=10&direction=long
GET /api/scan?minConfidence=0.5&maxResults=50&all=true
```

**Query Params:**
- `minConfidence` (0-1, default: 0.5)
- `maxResults` (int, default: 50)
- `direction` ('long' | 'short', optional)
- `intervals` (comma-separated, default: '4h,1h,15m,5m')
- `all` ('true' to scan 300+ pairs, default: false)

**Returns:** `{ summary: {...}, opportunities: [...] }`

---

## cURL Examples

```bash
# Get indicators
curl "http://localhost:3000/api/indicators/ETHUSDT?intervals=4h,1h"

# Get strategy signal
curl "http://localhost:3000/api/analyze/BTCUSDT"

# Scan for long opportunities
curl "http://localhost:3000/api/scan?minConfidence=0.7&direction=long&maxResults=5"

# Scan all Kraken pairs
curl "http://localhost:3000/api/scan?all=true&minConfidence=0.8"
```

---

## JavaScript Examples

```javascript
// Fetch strategy signal
const signal = await fetch('/api/analyze/BTCUSDT').then(r => r.json());

if (signal.valid && signal.confidence >= 0.75) {
  console.log(`${signal.direction} @ ${signal.confidence}`);
  console.log(`Entry: $${signal.entryZone.min} - $${signal.entryZone.max}`);
  console.log(`SL: $${signal.stopLoss}`);
  console.log(`TP: $${signal.targets.tp1} / $${signal.targets.tp2}`);
}

// Scan market
const scan = await fetch('/api/scan?minConfidence=0.6').then(r => r.json());
console.log(`Found ${scan.opportunities.length} opportunities`);
scan.opportunities.forEach(opp => {
  console.log(`${opp.symbol}: ${opp.direction} @ ${opp.confidence}`);
});
```

---

## Python Examples

```python
import requests

# Get strategy signal
response = requests.get('http://localhost:3000/api/analyze/BTCUSDT')
signal = response.json()

if signal['valid'] and signal['confidence'] >= 0.75:
    print(f"{signal['direction']} @ {signal['confidence']}")
    print(f"Entry: ${signal['entryZone']['min']} - ${signal['entryZone']['max']}")
    print(f"SL: ${signal['stopLoss']}")
    print(f"TP: ${signal['targets']['tp1']} / ${signal['targets']['tp2']}")

# Scan market
response = requests.get('http://localhost:3000/api/scan', params={
    'minConfidence': 0.6,
    'maxResults': 10,
    'direction': 'long'
})
scan = response.json()
print(f"Found {len(scan['opportunities'])} opportunities")
for opp in scan['opportunities']:
    print(f"{opp['symbol']}: {opp['direction']} @ {opp['confidence']}")
```

---

## Response Codes

- `200` - Success
- `400` - Bad request (missing/invalid parameters)
- `405` - Method not allowed (use GET)
- `500` - Internal server error

---

## Rate Limits

**Free Tier (Kraken API):**
- ~1 request/second per symbol
- Built-in delays in scanner to respect limits

**Best Practices:**
- Cache scanner results for 1-4 hours
- Use `/api/analyze` for real-time single-symbol checks
- Run full scanner every 4 hours (when 4H candle closes)

---

## Supported Symbols

**Curated (35):** BTC, ETH, SOL, BNB, ADA, XRP, DOGE, DOT, MATIC, LINK, AVAX, ATOM, UNI, AAVE, ALGO, ARB, OP, SHIB, PEPE, LTC, BCH, XLM, TRX, ETC, XMR, FIL, APT, NEAR, ICP, INJ, SUI, TON

**All Pairs:** Use `?all=true` to scan 300+ Kraken pairs

---

## Timeframes

Supported: `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`

Default: `4h,1h,15m,5m` (optimized for 4H strategy)

---

## Need More?

- Full docs: [DEPLOYMENT.md](./DEPLOYMENT.md)
- Examples: [VERCEL_DEPLOYMENT_SUMMARY.md](./VERCEL_DEPLOYMENT_SUMMARY.md)
- Main README: [README.md](./README.md)

