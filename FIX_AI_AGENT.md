# 🔧 Fix AI Agent - Invalid API Key

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## ❌ Current Issue

**Error:** `API returned 401: Unauthorized`

**Root Cause:** The OpenAI API key is invalid or expired.

---

## ✅ Solution: Get a Valid OpenAI API Key

### Step 1: Get New API Key from OpenAI

1. **Go to:** https://platform.openai.com/api-keys

2. **Sign in** to your OpenAI account
   - If you don't have an account, create one (it's free!)

3. **Click** "Create new secret key"

4. **Name it:** `EditTrades Production`

5. **Copy the key** - It will look like:
   ```
   sk-proj-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ```
   
   ⚠️ **Important:** Save this key somewhere safe! You can't see it again.

6. **Make sure you have credits:**
   - Go to: https://platform.openai.com/usage
   - Free trial gives you $5 in credits
   - Or add payment method for pay-as-you-go

---

### Step 2: Update Key in Vercel

**Option A: Via Vercel Dashboard (Easiest)**

1. Go to: https://vercel.com/baiees-projects/snapshot_tradingview

2. Click **Settings** (left sidebar)

3. Click **Environment Variables**

4. Find `OPENAI_API_KEY`

5. Click **"..."** → **"Edit"**

6. **Paste your NEW key**

7. Make sure **all environments** are selected:
   - ✅ Production
   - ✅ Preview
   - ✅ Development

8. Click **"Save"**

9. Go to **Deployments** tab

10. Click **"..."** on latest deployment → **"Redeploy"**

**Option B: Via CLI**

```bash
cd /Users/bballi/Documents/Repos/snapshot_tradingview

# Remove old key
vercel env rm OPENAI_API_KEY production

# Add new key
vercel env add OPENAI_API_KEY production
# When prompted, paste your NEW key

# Redeploy
vercel --prod --force
```

---

### Step 3: Test It!

1. Visit: https://snapshottradingview-os1freooy-baiees-projects.vercel.app

2. Click on **BTC** to expand details

3. Scroll to **"AI REASONING AGENT"**

4. Click **"GET AI REVIEW"**

5. Wait 2-5 seconds

**Expected:**
- ✅ "⏳ ANALYZING..." appears
- ✅ AI analysis loads with formatted trade call
- ✅ Priority rating shows (A+, A, B, or SKIP)

---

## 💡 Why Did This Happen?

**Possible reasons:**
1. **Key was a test/example key** - Not a real key from OpenAI
2. **Key was revoked** - Someone deleted it
3. **Account issue** - OpenAI account may need verification
4. **Format error** - Extra characters or spaces in the key

---

## 🆓 OpenAI Free Tier

**What you get:**
- $5 in free credits (enough for ~5,000 AI reviews!)
- GPT-4o-mini access
- No credit card required for free tier

**Costs (after free credits):**
- ~$0.001 per AI review
- ~$1 for 1,000 reviews
- Very affordable!

---

## 🧪 Test Your New Key

After updating, test with this command:

```bash
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer YOUR_NEW_KEY_HERE"
```

**If valid, you'll see:**
```json
{
  "object": "list",
  "data": [...]
}
```

**If invalid, you'll see:**
```json
{
  "error": {
    "message": "Incorrect API key provided..."
  }
}
```

---

## 🎯 Summary

**To Fix:**
1. ✅ Get valid key from: https://platform.openai.com/api-keys
2. ✅ Update in Vercel: Settings → Environment Variables
3. ✅ Redeploy your project
4. ✅ Test "GET AI REVIEW" button

**Estimated time:** 2-3 minutes

---

## 🆘 Still Not Working?

If you get a new key and it still doesn't work:

1. **Check OpenAI account status**: https://platform.openai.com/account
2. **Verify credits available**: https://platform.openai.com/usage
3. **Check Vercel logs**: https://vercel.com/baiees-projects/snapshot_tradingview (Deployments → Functions)
4. **Clear browser cache** and try again

---

**Once you have a valid key, the AI agent will work perfectly!** 🤖✨

