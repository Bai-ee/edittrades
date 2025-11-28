# 🚀 Deploy to Vercel - Complete Guide

## Prerequisites

✅ Code pushed to GitHub (see PUSH_TO_GITHUB.md)  
✅ OpenAI API key ready (get yours at: https://platform.openai.com/api-keys)

---

## Method 1: Deploy via Vercel Dashboard (Recommended)

### Step 1: Go to Vercel

1. Open: https://vercel.com
2. Sign in (or create account with GitHub)

### Step 2: Import Repository

1. Click **"Add New"** → **"Project"**
2. Click **"Import Git Repository"**
3. Find your repository: `edittrades` or `snapshot-tradingview`
4. Click **"Import"**

### Step 3: Configure Project

Vercel will auto-detect most settings. Verify:

- **Framework Preset**: Other (or leave as detected)
- **Root Directory**: `./` (default)
- **Build Command**: Leave empty
- **Output Directory**: `public`
- **Install Command**: `npm install`

**Click "Deploy"** ✨

### Step 4: Wait for Deployment

⏳ First deployment takes ~2-3 minutes

You'll see:
- Installing dependencies...
- Building serverless functions...
- Deploying...
- ✅ **Success!**

### Step 5: Add OpenAI API Key (CRITICAL!)

⚠️ **The AI agent won't work without this step!**

1. **Go to your project** → **Settings**
2. Click **Environment Variables**
3. **Add new variable:**

```
Name:  OPENAI_API_KEY
Value: your_openai_api_key_here

Environments: ✅ Production ✅ Preview ✅ Development
```

4. **Click "Save"**

### Step 6: Redeploy

After adding the API key:

1. Go to **Deployments** tab
2. Find the latest deployment
3. Click **"..."** (three dots)
4. Click **"Redeploy"**
5. Wait ~1-2 minutes

---

## Method 2: Deploy via CLI (Alternative)

If you prefer command line:

```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview

# Login to Vercel
vercel login

# Deploy to production
vercel --prod

# Add environment variable
vercel env add OPENAI_API_KEY production
# When prompted, paste your OpenAI API key
```

---

## Your Live URLs

After deployment, you'll get:

**Production URL:**
```
https://edittrades.vercel.app
(or https://your-project-name.vercel.app)
```

**API Endpoints:**
```
https://edittrades.vercel.app/api/analyze/BTCUSDT
https://edittrades.vercel.app/api/indicators/BTCUSDT
https://edittrades.vercel.app/api/agent-review
```

---

## Test Your Deployment

### 1. Test Homepage
Visit: `https://your-project.vercel.app`

**Expected:**
- ✅ See BTC, ETH, SOL coins
- ✅ Prices loading
- ✅ Trading signals displaying

### 2. Test Coin Details
Click any coin to expand

**Expected:**
- ✅ Timeframe cards display
- ✅ Entry/Stop/Target info shows
- ✅ "AI REASONING AGENT" section appears

### 3. Test AI Agent
Click **"GET AI REVIEW"**

**Expected:**
- ✅ Button changes to "⏳ ANALYZING..."
- ✅ Wait 2-5 seconds
- ✅ AI analysis appears with:
  - Priority rating (A+, A, B, SKIP)
  - Formatted trade call
  - Confluence analysis
  - Agent reasoning

**If this works → 🎉 DEPLOYMENT SUCCESSFUL!**

---

## Troubleshooting

### AI Review Shows Error

**Problem:** "❌ AI Review Failed"

**Solutions:**
1. Check environment variable is set: Settings → Environment Variables
2. Verify API key is correct
3. Check OpenAI account has credits: https://platform.openai.com/usage
4. Redeploy after adding/fixing the key

### API Endpoints Return Errors

**Problem:** `/api/analyze` or `/api/agent-review` fails

**Solutions:**
1. Check Vercel function logs: Deployments → Functions tab
2. Verify all files pushed to GitHub
3. Check `vercel.json` routes configuration
4. Redeploy

### Prices Not Loading

**Problem:** Coins show "N/A" for prices

**Solutions:**
1. Check Kraken API is accessible
2. Verify serverless functions are deployed
3. Check browser console for errors
4. Wait a moment and refresh

---

## Auto-Deploy Setup

**After initial deployment, Vercel automatically:**

✅ Watches your GitHub repository  
✅ Deploys on every push to `main`  
✅ Creates preview deployments for PRs  
✅ Sends deployment notifications  

**Just push to GitHub and Vercel deploys!**

```bash
git add .
git commit -m "Update feature"
git push

# Vercel automatically deploys! 🚀
```

---

## Monitoring Your App

### Deployment Logs
View real-time logs:
1. Vercel Dashboard → Your Project
2. Click **Deployments**
3. Click any deployment
4. View **Build Logs** and **Function Logs**

### Analytics
View traffic and performance:
1. Vercel Dashboard → Your Project
2. Click **Analytics** tab
3. See requests, latency, errors

### Function Logs
Debug serverless functions:
1. Deployments → Select deployment
2. Click **Functions** tab
3. See execution logs for each API call

---

## Cost Estimate

**Vercel (Free Tier):**
- ✅ Unlimited deployments
- ✅ 100GB bandwidth/month
- ✅ Serverless functions included
- **Cost: FREE** 🆓

**OpenAI API (GPT-4o-mini):**
- ~$0.001 - $0.003 per AI review
- ~$1 for 500-1000 reviews
- **Cost: Very Low** 💰

**Total monthly cost: < $5** for typical usage

---

## Security Best Practices

✅ **API key in environment variables** (not in code)  
✅ **HTTPS enabled** by default  
✅ **CORS configured** properly  
✅ **No sensitive data** in frontend  
✅ **Rate limiting** via Vercel  

---

## Custom Domain (Optional)

Want your own domain like `edittrades.com`?

1. Buy domain (Namecheap, GoDaddy, etc.)
2. Vercel Dashboard → Your Project → **Settings**
3. Click **Domains**
4. Add your domain
5. Follow DNS setup instructions
6. Wait for propagation (~1-24 hours)

---

## 🎉 You're Live!

**Your AI-powered trading assistant is now:**
- ✅ Deployed globally via Vercel CDN
- ✅ Auto-deploying on every Git push
- ✅ Analyzing trades with ChatGPT
- ✅ Accessible from anywhere

**Share your live URL and start trading! 📈**

---

## Support & Resources

- **Vercel Docs**: https://vercel.com/docs
- **Vercel Support**: support@vercel.com
- **OpenAI API Docs**: https://platform.openai.com/docs
- **Your Project Docs**: See AI_AGENT_SETUP.md

---

**Need help? Check function logs in Vercel dashboard or review the troubleshooting section above.**

