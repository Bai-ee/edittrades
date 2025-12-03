# 🔐 Vercel Environment Variables Setup for Trading

## 🚨 **CRITICAL: Required for Trade Execution**

Trading functionality **will fail** in production if environment variables are not set in Vercel.

---

## ✅ **Required Environment Variables**

### 1. `SOLANA_PRIVATE_KEY` ⚠️ **REQUIRED**

**Purpose:** Solana wallet private key for signing transactions

**Format:** Base58-encoded private key (64 bytes) or seed (32 bytes)

**How to get:**
```bash
# Generate a new wallet (if needed)
node scripts/generate-wallet-with-phrase.js

# Or use existing private key from .env file
# Copy the value from your local .env file
```

**Vercel Setup:**
1. Go to **Vercel Dashboard** → Your Project
2. Click **Settings** → **Environment Variables**
3. Click **Add New**
4. **Name:** `SOLANA_PRIVATE_KEY`
5. **Value:** Your private key (base58 format)
6. **Environments:** ✅ Production ✅ Preview ✅ Development
7. Click **Save**

**⚠️ Security Warning:**
- This is a **hot wallet** with real funds
- Only use a wallet with minimal funds for testing
- Never commit this to Git
- Consider using Vercel's encrypted environment variables

---

### 2. `SOLANA_RPC_URL` (Optional)

**Purpose:** Custom Solana RPC endpoint (defaults to public mainnet if not set)

**Default:** `https://api.mainnet-beta.solana.com`

**Recommended:** Use a private RPC provider for better reliability:
- Helius: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
- QuickNode: `https://YOUR_ENDPOINT.solana-mainnet.quiknode.pro/YOUR_KEY`
- Alchemy: `https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY`

**Vercel Setup:**
1. **Name:** `SOLANA_RPC_URL`
2. **Value:** Your RPC endpoint URL
3. **Environments:** ✅ Production ✅ Preview ✅ Development

---

### 3. `JUPITER_API_KEY` (Optional)

**Purpose:** Jupiter API key for higher rate limits (free tier works without it)

**Default:** None (uses free tier: 60 requests/minute)

**When to use:**
- If you're making >60 trades/minute
- For production with high volume

**Vercel Setup:**
1. **Name:** `JUPITER_API_KEY`
2. **Value:** Your Jupiter API key (if you have one)
3. **Environments:** ✅ Production ✅ Preview ✅ Development

---

### 4. `MAX_TRADE_SIZE_USD` (Optional)

**Purpose:** Maximum trade size in USD (safety limit)

**Default:** `1000` (USD)

**Vercel Setup:**
1. **Name:** `MAX_TRADE_SIZE_USD`
2. **Value:** `1000` (or your preferred limit)
3. **Environments:** ✅ Production ✅ Preview ✅ Development

---

## 🔍 **How to Verify Environment Variables**

### Method 1: Check Vercel Dashboard
1. Go to **Vercel Dashboard** → Your Project
2. Click **Settings** → **Environment Variables**
3. Verify all required variables are present
4. Check that they're enabled for **Production** environment

### Method 2: Test Trade Execution
1. Deploy to production
2. Try to execute a small test trade ($0.25 minimum)
3. Check Vercel function logs:
   - Go to **Deployments** → Latest deployment
   - Click **Functions** → `/api/execute-trade`
   - Click **Logs**
   - Look for `[WalletManager]` or `[ExecuteTrade]` messages

### Method 3: Health Check (if implemented)
```bash
curl https://your-app.vercel.app/api/health
```

---

## 🐛 **Common Issues & Solutions**

### Issue 1: "SOLANA_PRIVATE_KEY environment variable is not set"

**Symptom:**
```json
{
  "error": "Service configuration error",
  "message": "Trading wallet not configured. Please set SOLANA_PRIVATE_KEY in Vercel environment variables."
}
```

**Solution:**
1. Add `SOLANA_PRIVATE_KEY` to Vercel environment variables (see above)
2. **Redeploy** after adding the variable
3. Wait for deployment to complete (~1-2 minutes)

---

### Issue 2: "Failed to load wallet"

**Symptom:**
```json
{
  "error": "Service configuration error",
  "message": "Wallet configuration error. Please check SOLANA_PRIVATE_KEY in Vercel environment variables."
}
```

**Possible Causes:**
- Invalid private key format
- Key is truncated or has extra characters
- Wrong encoding (should be base58)

**Solution:**
1. Verify the key format in your local `.env` file
2. Copy the **exact** value (no spaces, no quotes)
3. Paste into Vercel environment variable
4. Redeploy

---

### Issue 3: Trade works locally but fails in production

**Symptom:**
- ✅ Local: Trade executes successfully
- ❌ Production: "Trade execution failed"

**Root Cause:**
Environment variables are set locally (`.env` file) but not in Vercel.

**Solution:**
1. Check which environment variables are used:
   ```bash
   # In your code, look for:
   process.env.SOLANA_PRIVATE_KEY
   process.env.SOLANA_RPC_URL
   process.env.JUPITER_API_KEY
   ```
2. Add **all** required variables to Vercel
3. Redeploy

---

## 📋 **Deployment Checklist**

Before deploying trading functionality:

- [ ] `SOLANA_PRIVATE_KEY` added to Vercel (Production, Preview, Development)
- [ ] `SOLANA_RPC_URL` added (optional, but recommended)
- [ ] `JUPITER_API_KEY` added (optional, for higher rate limits)
- [ ] `MAX_TRADE_SIZE_USD` added (optional, safety limit)
- [ ] All variables enabled for **Production** environment
- [ ] Redeployed after adding variables
- [ ] Tested with small trade ($0.25) in production
- [ ] Verified wallet has sufficient SOL for transaction fees

---

## 🔄 **After Adding Environment Variables**

**IMPORTANT:** Environment variables are only loaded during deployment.

1. **Add variables** in Vercel Dashboard
2. **Redeploy** (required):
   - Go to **Deployments** tab
   - Click **"..."** on latest deployment
   - Click **"Redeploy"**
   - Wait for deployment to complete
3. **Test** trade execution

---

## 📚 **Related Documentation**

- `docs/JUPITER_TRADING_INTEGRATION.md` - Jupiter API setup
- `docs/SOLANA_WALLET_SETUP.md` - Wallet generation and setup
- `docs/VERCEL_DEPLOY.md` - General Vercel deployment guide

---

## 🆘 **Still Having Issues?**

1. **Check Vercel Function Logs:**
   - Go to **Deployments** → Latest deployment
   - Click **Functions** → `/api/execute-trade`
   - Click **Logs**
   - Look for error messages starting with `[ExecuteTrade]` or `[WalletManager]`

2. **Compare Local vs Production:**
   - Local: Check `server.log` or console output
   - Production: Check Vercel function logs
   - Compare error messages

3. **Verify Environment Variables:**
   - Use Vercel CLI: `vercel env ls`
   - Or check Dashboard: Settings → Environment Variables

---

**Last Updated:** 2025-12-03  
**Issue:** Trade execution fails in production due to missing `SOLANA_PRIVATE_KEY`  
**Status:** ✅ Documented and fixed with better error handling

