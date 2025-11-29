# 🔧 Troubleshooting Guide

## "Failed to Fetch" Error

### Quick Fixes

#### 1. **Refresh the Browser**
```
Press: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)
```
This does a hard refresh and clears the cache.

#### 2. **Check Server Status**
In terminal:
```bash
curl http://localhost:3000/health
```

Should return:
```json
{"status":"ok","timestamp":"...","service":"Snapshot TradingView API"}
```

If you get "Connection refused":
```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview
npm start
```

#### 3. **Test in Browser Console**
1. Open browser console (F12 or Cmd+Option+I)
2. Go to Console tab
3. Type:
```javascript
fetch('/health').then(r => r.json()).then(console.log)
```

Should log: `{status: "ok", ...}`

#### 4. **Use Debug Button**
- Open http://localhost:3000
- Click "Test API Connection" button
- Should show: ✅ All systems operational!

---

## Common Issues

### Issue: "Failed to fetch" in browser

**Cause:** Server not running or crashed

**Solution:**
```bash
# Check if server is running
lsof -i :3000

# If nothing shows, start server
cd /Users/bballi/Documents/Repos/snapshot_tradingview
npm start
```

---

### Issue: API works in terminal but not browser

**Cause:** Browser cache or CORS issue

**Solutions:**

1. **Hard refresh browser:** Cmd+Shift+R
2. **Clear browser cache:**
   - Chrome: Settings → Privacy → Clear browsing data
   - Safari: Develop → Empty Caches
3. **Try incognito/private mode**
4. **Try different browser**

---

### Issue: Blank page or no UI

**Cause:** HTML not loading

**Solution:**
```bash
# Verify file exists
ls -la /Users/bballi/Documents/Repos/snapshot_tradingview/public/index.html

# Restart server
pkill -f "node server.js"
cd /Users/bballi/Documents/Repos/snapshot_tradingview
npm start

# Then refresh browser
```

---

### Issue: "Cannot GET /"

**Cause:** Server routing issue

**Check:**
```bash
# Verify server.js exists and has routes
grep "app.get('/'," /Users/bballi/Documents/Repos/snapshot_tradingview/server.js
```

Should show: `app.get('/', (req, res) => {`

---

### Issue: CoinGecko rate limit (429 error)

**Cause:** Too many requests (50/min free tier)

**Solution:**
- Wait 1 minute
- Reduce refresh frequency
- Consider upgrading to CoinGecko Pro

---

### Issue: Symbol not found

**Supported symbols:**
- BTCUSDT (Bitcoin)
- ETHUSDT (Ethereum)  
- SOLUSDT (Solana)
- BNBUSDT (Binance Coin)
- ADAUSDT (Cardano)
- DOGEUSDT (Dogecoin)
- XRPUSDT (Ripple)
- DOTUSDT (Polkadot)
- MATICUSDT (Polygon)
- LINKUSDT (Chainlink)

**To add more:**
Edit `services/coingecko.js` and add to SYMBOL_MAP

---

## Debug Checklist

When things aren't working:

- [ ] Is server running? (`lsof -i :3000`)
- [ ] Can you access http://localhost:3000 in browser?
- [ ] Does `/health` endpoint work? (`curl localhost:3000/health`)
- [ ] Does `/api/ticker/BTCUSDT` work? (`curl localhost:3000/api/ticker/BTCUSDT`)
- [ ] Did you hard refresh browser? (Cmd+Shift+R)
- [ ] Any errors in browser console? (F12 → Console tab)
- [ ] Any errors in server terminal?

---

## Browser Console Errors

### "net::ERR_CONNECTION_REFUSED"
**Meaning:** Server is not running

**Fix:**
```bash
npm start
```

### "Failed to fetch"
**Meaning:** Network error between browser and server

**Fixes:**
1. Hard refresh (Cmd+Shift+R)
2. Check server is running
3. Try http://localhost:3000 directly in address bar

### "Unexpected token < in JSON"
**Meaning:** Getting HTML instead of JSON (server routing issue)

**Fix:**
```bash
# Restart server
pkill -f "node server.js"
npm start
```

---

## Testing Each Component

### 1. Test Server
```bash
curl http://localhost:3000/health
# Should return JSON with status: "ok"
```

### 2. Test API - Ticker
```bash
curl http://localhost:3000/api/ticker/BTCUSDT
# Should return BTC price
```

### 3. Test API - Multi-timeframe
```bash
curl "http://localhost:3000/api/multi/BTCUSDT?intervals=4h"
# Should return analysis object
```

### 4. Test Frontend
```bash
open http://localhost:3000
# Should load dashboard UI
```

---

## Still Having Issues?

### Get Server Logs
```bash
# Server should be running in terminal showing:
# "Snapshot TradingView Server Running"
# If not visible, check background processes:
ps aux | grep node
```

### Full Reset
```bash
# Kill any running servers
pkill -f "node server.js"

# Clean install
cd /Users/bballi/Documents/Repos/snapshot_tradingview
rm -rf node_modules package-lock.json
npm install

# Start fresh
npm start

# Wait 2 seconds, then test
curl http://localhost:3000/health

# Open browser
open http://localhost:3000
```

---

## Browser Developer Tools

### Enable Console (F12 or Cmd+Option+I)

**Tabs to check:**

1. **Console** - Shows JavaScript errors
   - Look for red errors
   - Check "Failed to fetch" details

2. **Network** - Shows API requests
   - Click on request to see details
   - Check Status Code (should be 200)
   - Check Response

3. **Application** - Cache and storage
   - Can clear cache here if needed

---

## Port Already in Use

If you get "Port 3000 already in use":

```bash
# Find what's using port 3000
lsof -i :3000

# Kill that process
kill -9 <PID>

# Or use different port
PORT=3001 npm start
# Then access http://localhost:3001
```

---

## Network Issues

### Behind Corporate Firewall?
- Some firewalls block localhost:3000
- Try 127.0.0.1:3000 instead
- Or try different port: `PORT=8080 npm start`

### VPN Active?
- Some VPNs interfere with localhost
- Try disconnecting VPN temporarily

---

## Emergency Quick Start

If nothing works, try this complete restart:

```bash
# 1. Go to project directory
cd /Users/bballi/Documents/Repos/snapshot_tradingview

# 2. Kill any old processes
pkill -f "node server.js"

# 3. Make sure dependencies installed
npm install

# 4. Start server (watch for any errors)
npm start

# 5. Wait 3 seconds

# 6. In NEW terminal window, test:
curl http://localhost:3000/health

# 7. If that works, open browser:
open http://localhost:3000

# 8. Click "Test API Connection" button

# 9. Try analyzing BTC
```

If that doesn't work, check for error messages in the terminal where you ran `npm start`.

---

## Getting More Help

**Check server logs:** Look at terminal where `npm start` is running

**Browser console:** F12 → Console tab (shows frontend errors)

**Test API manually:** Use curl commands above

**Common pattern:**
- API works in curl ✅
- Browser shows error ❌
- → Usually cache issue → Hard refresh!

---

## Success Indicators

**You know it's working when:**

1. Server terminal shows: "✨ Ready to analyze crypto markets!"
2. `curl localhost:3000/health` returns JSON
3. Browser loads dashboard at http://localhost:3000
4. "Test API Connection" button shows: ✅ All systems operational!
5. Clicking BTC button shows analysis

---

**Most Common Fix:** Hard refresh browser (Cmd+Shift+R) ⚡



