# Funding Wallet with USDC Guide

**Question:** Can I fund the wallet with USDC and trade with that?

**Answer:** Yes! You can fund with USDC and trade USDC pairs. However, you still need a small amount of SOL for transaction fees.

---

## How It Works

### Funding Requirements

1. **USDC** - For trading (your main trading capital)
   - Send USDC to your wallet address
   - This is what you'll use to buy BTC/ETH/SOL tokens
   - Recommended: $100-500 for testing

2. **SOL** - For transaction fees (required)
   - You need SOL to pay for transaction fees
   - Each transaction costs ~0.000005 SOL (~$0.0001)
   - Recommended: 0.01-0.05 SOL for testing (covers many transactions)

### Why You Need Both

- **USDC** = Your trading capital (what you're buying/selling with)
- **SOL** = Gas fees (required to execute transactions on Solana)

Think of it like:
- USDC = The money you're spending
- SOL = The fee to process the transaction

---

## Step-by-Step Funding

### Step 1: Get Your Wallet Address

Your wallet address is:
```
2z6K4fNUsYVwQcqcAawYnMGjBhRVbHmgyYSMD8C3rNVy
```

### Step 2: Fund with USDC

**Option A: From Exchange (Coinbase, Binance, etc.)**
1. Buy USDC on exchange
2. Withdraw USDC to Solana network
3. Send to: `2z6K4fNUsYVwQcqcAawYnMGjBhRVbHmgyYSMD8C3rNVy`
4. **Important:** Select Solana network (not Ethereum!)

**Option B: From Another Solana Wallet**
1. Open Phantom/Solflare
2. Send USDC
3. Paste your wallet address
4. Confirm transaction

**Recommended Amount:** $100-500 USDC for testing

### Step 3: Fund with SOL (For Fees)

**Option A: From Exchange**
1. Buy SOL on exchange
2. Withdraw to Solana network
3. Send to: `2z6K4fNUsYVwQcqcAawYnMGjBhRVbHmgyYSMD8C3rNVy`

**Option B: Swap USDC for SOL (After USDC arrives)**
- Use Jupiter swap in your wallet
- Swap ~$2-5 worth of USDC to SOL
- This gives you enough SOL for many transactions

**Recommended Amount:** 0.01-0.05 SOL (~$1-5)

---

## How Trading Works with USDC

### Example: BTC Long Trade

1. **Signal:** BTC long at $90,000
2. **Your Action:** Click "Execute Trade" with $100 USDC
3. **What Happens:**
   - System swaps 100 USDC → BTC
   - Transaction fee: ~0.000005 SOL (paid from your SOL balance)
   - You now hold BTC
4. **Result:** You're long BTC, paid for with USDC

### Example: ETH Long Trade

1. **Signal:** ETH long at $3,000
2. **Your Action:** Click "Execute Trade" with $200 USDC
3. **What Happens:**
   - System swaps 200 USDC → ETH
   - Transaction fee: ~0.000005 SOL
   - You now hold ETH
4. **Result:** You're long ETH, paid for with USDC

---

## Checking Your Balances

### Check USDC Balance

```bash
node -e "
import('./services/walletManager.js').then(async (m) => {
  const connection = m.getConnection();
  const wallet = m.getWallet();
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  
  // Get USDC token account
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new (await import('@solana/web3.js')).PublicKey(usdcMint) }
  );
  
  if (tokenAccounts.value.length > 0) {
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    console.log('USDC Balance:', balance);
  } else {
    console.log('USDC Balance: 0 (no token account found)');
  }
})
"
```

### Check SOL Balance

```bash
node -e "import('./services/walletManager.js').then(async (m) => console.log('SOL Balance:', await m.getBalance(), 'SOL'))"
```

---

## Minimum Funding Recommendations

### For Testing
- **USDC:** $50-100 (enough for a few small trades)
- **SOL:** 0.01 SOL (~$1) (covers ~2000 transactions)

### For Small Trading
- **USDC:** $200-500 (more trading capital)
- **SOL:** 0.05 SOL (~$5) (covers many transactions)

### For Production
- **USDC:** Based on your trading strategy
- **SOL:** 0.1-0.5 SOL (always keep some for fees)

---

## Transaction Fee Breakdown

Each trade execution costs:
- **Swap Fee:** ~0.000005 SOL (~$0.0001)
- **Priority Fee:** Variable (usually 0.000001-0.00001 SOL)
- **Total:** ~$0.0001-0.0002 per trade

**Example:** With 0.01 SOL, you can execute ~2000 trades before running out of fees.

---

## Important Notes

### ✅ Advantages of Using USDC

1. **Stable Value:** USDC = $1 (no price volatility)
2. **Direct Trading:** Trade BTC/ETH/SOL directly with USDC
3. **No Conversion Needed:** Don't need to convert SOL to USDC first
4. **Easier Accounting:** Track trades in USD terms

### ⚠️ Things to Remember

1. **Always Keep SOL:** Don't swap all your SOL to USDC - keep some for fees
2. **Network Selection:** When sending USDC, make sure you select Solana network
3. **Token Address:** USDC on Solana is different from USDC on Ethereum
4. **Minimum Amounts:** Some DEXs have minimum swap amounts

---

## Troubleshooting

### "Insufficient funds for transaction"

**Cause:** Not enough SOL for fees

**Solution:**
1. Check SOL balance
2. Send more SOL to wallet
3. Keep at least 0.01 SOL for fees

### "Token account not found"

**Cause:** Wallet doesn't have a USDC token account yet

**Solution:**
1. This is normal for new wallets
2. First USDC transaction will create the account
3. Or send a small amount of USDC first to create the account

### "Slippage tolerance exceeded"

**Cause:** Price moved too much during swap

**Solution:**
1. Increase slippage tolerance (currently 1%)
2. Try again when market is less volatile
3. Use smaller trade amounts

---

## Quick Reference

### Your Wallet Address
```
2z6K4fNUsYVwQcqcAawYnMGjBhRVbHmgyYSMD8C3rNVy
```

### USDC Token Address (Solana)
```
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

### Recommended Funding
- USDC: $100-500
- SOL: 0.01-0.05 SOL

### Check Balances
```bash
# SOL
node -e "import('./services/walletManager.js').then(async (m) => console.log(await m.getBalance(), 'SOL'))"

# USDC (see script above)
```

---

## Next Steps

1. ✅ Fund wallet with USDC ($100-500 recommended)
2. ✅ Fund wallet with SOL (0.01-0.05 SOL for fees)
3. ✅ Verify balances
4. ✅ Test with small trade ($10-50)
5. ✅ Monitor transaction fees

You're all set! The system now uses USDC as the base currency for trading.

