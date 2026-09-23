# 🔧 Fixing 500 Errors on Vercel Deployment

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## 🐛 **The Problem**

Console shows:
```
Failed to load resource: the server responded with a status of 500 ()
/api/analyze/BTCUSDT - 500
/api/analyze/ETHUSDT - 500
/api/analyze/SOLUSDT - 500
```

---

## 🔍 **IMMEDIATE DIAGNOSTIC STEPS**

### Step 1: Check Health Endpoint
I've added a health check endpoint. Visit:
```
https://your-vercel-url.vercel.app/api/health
```

This will show:
- ✅ API is running
- ✅ Node version
- ✅ OpenAI API key status

### Step 2: Check Vercel Logs
1. Go to **https://vercel.com/dashboard**
2. Click your **EditTrades** project
3. Click **"Deployments"**
4. Click the latest deployment
5. Click **"Functions"** tab
6. Click `/api/analyze`
7. View **"Logs"** - this will show the actual error

---

## 🎯 **MOST LIKELY CAUSES**

### 1. **Missing OPENAI_API_KEY** ⚠️
**Symptom:** All API calls fail with 500  
**Fix:**
```bash
# In Vercel Dashboard:
1. Go to your project
2. Click "Settings"
3. Click "Environment Variables"
4. Add: OPENAI_API_KEY = sk-proj-...
5. Redeploy
```

### 2. **Kraken API Rate Limiting**
**Symptom:** Intermittent 500s, especially on first load  
**Fix:** Wait 30 seconds and retry

### 3. **Module Import Issues**
**Symptom:** All API calls fail immediately  
**Fix:** Check Vercel build logs for import errors

### 4. **Timeout (10s limit on Hobby plan)**
**Symptom:** 500 after exactly 10 seconds  
**Fix:** Optimize or upgrade Vercel plan

---

## 🚀 **IMMEDIATE FIX - Test Locally First**

Your local server is working fine (`http://localhost:3000`), so the code is correct.

The issue is **Vercel-specific**.

---

## ✅ **STEP-BY-STEP FIX**

### Step 1: Check OpenAI API Key

```bash
# In Vercel Dashboard
1. Project Settings → Environment Variables
2. Confirm OPENAI_API_KEY exists
3. If missing, add it:
   Name: OPENAI_API_KEY
   Value: sk-proj-your-key-here
   Environment: Production, Preview, Development
4. Click "Save"
```

### Step 2: Redeploy

After adding environment variables:
```bash
# Option A: Force redeploy from Vercel Dashboard
1. Go to Deployments
2. Click "..." on latest deployment
3. Click "Redeploy"

# Option B: Push a small change to trigger redeploy
cd /Users/bballi/Documents/Repos/snapshot_tradingview
git commit --allow-empty -m "Trigger redeploy"
git push origin main
```

### Step 3: Check Logs Again

After redeployment:
1. Visit `/api/health` endpoint
2. Try loading homepage again
3. Check Vercel Function logs for any remaining errors

---

## 🔧 **ENHANCED ERROR LOGGING**

I've added better error logging to `/api/analyze`:
- Stack traces in development
- Console error logging
- Detailed error messages

Next deployment will show more details in Vercel logs.

---

## 📊 **DIAGNOSTIC ENDPOINTS**

### Test These URLs (replace with your Vercel URL):

```bash
# 1. Health check
https://your-app.vercel.app/api/health
# Should return: {"status":"ok", "hasOpenAIKey":true}

# 2. Single analyze call
https://your-app.vercel.app/api/analyze/BTCUSDT
# Should return full market data JSON or detailed error

# 3. Scan endpoint
https://your-app.vercel.app/api/scan
# Should return array of opportunities
```

---

## 🐛 **OTHER ERRORS IN CONSOLE**

### 1. **MetaMask Errors** (Ignore)
```
Cannot redefine property: ethereum
```
This is from browser extensions (MetaMask, Phantom), not your code.

### 2. **share-modal.js Error** (Low Priority)
```
Cannot read properties of null (reading 'addEventListener')
```
This is a missing element - non-critical, can fix later.

---

## 🎯 **QUICK CHECKLIST**

Run through this checklist:

### Vercel Dashboard:
- [ ] Environment Variables → OPENAI_API_KEY exists
- [ ] Latest deployment shows "Ready" (green)
- [ ] Functions tab shows no errors
- [ ] Logs show successful API calls

### Test Endpoints:
- [ ] `/api/health` returns 200
- [ ] `/api/analyze/BTCUSDT` returns market data
- [ ] Homepage loads without 500 errors

### If Still Failing:
- [ ] Check Vercel function logs for specific error
- [ ] Verify OpenAI API key is valid
- [ ] Check Vercel plan limits (timeout, execution time)
- [ ] Test local server works (`npm start`)

---

## 🔥 **MOST COMMON FIX**

**90% of the time, it's missing environment variables.**

1. Add `OPENAI_API_KEY` to Vercel
2. Redeploy
3. Done ✅

---

## 📝 **CURRENT STATUS**

✅ **Local server** - Working perfectly  
❌ **Vercel deployment** - 500 errors on `/api/analyze`  
🔧 **Diagnostic tools added** - `/api/health` endpoint  
📊 **Enhanced logging** - Better error messages  
⏳ **Next deployment** - Will show detailed errors

---

## 🚀 **NEXT STEPS**

1. **Push these diagnostic changes:**
```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview
git add -A
git commit -m "Add diagnostic endpoint and enhanced error logging"
git push origin main
```

2. **Wait for Vercel to deploy** (1-2 min)

3. **Test health endpoint:**
```
https://your-vercel-url/api/health
```

4. **Check environment variables** in Vercel Dashboard

5. **View function logs** to see actual error

---

## 📞 **IF YOU NEED MORE HELP**

Share with me:
1. Screenshot of Vercel function logs
2. Response from `/api/health` endpoint
3. Screenshot of Environment Variables page

---

*Created: 2025-11-28*  
*Status: Diagnosing 500 errors*  
*Next: Push diagnostic changes and check Vercel logs*

