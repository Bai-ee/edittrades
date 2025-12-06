# Swap Troubleshooting Guide

**Last Updated:** 2025-12-03  
**Status:** Common Issues and Solutions

---

## Common Issues and Solutions

### 1. Token Address Resolution Failures

**Symptom:**
```
Error: Token address not found for symbol: BTCUSDT
```

**Possible Causes:**
- Symbol not in `TOKEN_ADDRESSES` mapping
- Symbol case mismatch (should be uppercase)
- Token mapping not updated for new token

**Solutions:**
1. Check `services/tokenMapping.js` for symbol mapping
2. Verify symbol is uppercase: `symbol.toUpperCase()`
3. Add new token mapping using `addTokenMapping(symbol, address, decimals)`
4. Verify token address is correct Solana mint address

**Prevention:**
- Always use uppercase symbols
- Verify token addresses on Solana explorer before adding
- Test token mapping with `getTokenAddress()` function

---

### 2. Decimal Conversion Errors

**Symptom:**
```
Error: Invalid token amount calculated: NaN tokens
Error: Invalid token amount: Infinity
```

**Possible Causes:**
- Incorrect decimal calculation
- Division by zero (price is 0)
- Token decimals not set correctly

**Solutions:**
1. Verify `getTokenDecimals(symbol)` returns correct value
2. Check price is not zero: `currentPrice > 0`
3. Validate amount before conversion: `isNaN(amount) || !isFinite(amount)`
4. Use `Math.floor()` for `toTokenAmount()` to avoid floating point issues

**Example Fix:**
```javascript
// Before
const tokenAmount = amountUSD / currentPrice;

// After (with validation)
if (!currentPrice || currentPrice <= 0) {
  throw new Error('Invalid current price for token amount calculation');
}
const tokenAmount = (amountUSD / currentPrice) * bufferMultiplier;
```

---

### 3. Insufficient Balance Errors

**Symptom:**
```
Transaction failed: insufficient funds
Error: Account has insufficient funds
```

**Possible Causes:**
- Wallet doesn't have enough USDC for buy trades
- Wallet doesn't have enough tokens for sell trades
- Wallet doesn't have enough SOL for transaction fees

**Solutions:**
1. **Check USDC Balance (for buys):**
   ```javascript
   // Need: amountUSD in USDC
   // Check: wallet USDC balance >= amountUSD
   ```

2. **Check Token Balance (for sells):**
   ```javascript
   // Need: tokenAmount in tokens
   // Check: wallet token balance >= tokenAmount
   ```

3. **Check SOL Balance (for fees):**
   ```javascript
   // Need: ~0.000005 SOL per transaction
   // Check: wallet SOL balance >= 0.001 SOL (safety buffer)
   ```

4. **Fund Wallet:**
   - Send USDC to wallet for buy trades
   - Send tokens to wallet for sell trades
   - Always maintain SOL for transaction fees

**Prevention:**
- Check balances before executing trades
- Show balance warnings in UI
- Implement balance validation in `tradeExecution.js`

---

### 4. Transaction Confirmation Timeouts

**Symptom:**
```
Transaction pending for >30 seconds
Polling timeout: Transaction not confirmed
```

**Possible Causes:**
- Network congestion on Solana
- RPC endpoint slow or unresponsive
- Transaction stuck in mempool

**Solutions:**
1. **Check RPC Endpoint:**
   - Verify `SOLANA_RPC_URL` is accessible
   - Try different RPC provider (QuickNode, Helius, Alchemy)
   - Check RPC status/health

2. **Increase Timeout:**
   ```javascript
   // In pollTradeStatus()
   const maxAttempts = 60; // Increase from 30
   const interval = 10000; // 10 seconds
   ```

3. **Check Transaction Status:**
   - Use Solscan explorer to check transaction
   - Verify transaction signature is valid
   - Check if transaction was dropped from mempool

4. **Retry Logic:**
   - Implement automatic retry for failed transactions
   - Use exponential backoff
   - Show user option to retry manually

**Prevention:**
- Use reliable RPC endpoint
- Monitor transaction confirmation times
- Implement proper timeout handling

---

### 5. Slippage Exceeded Errors

**Symptom:**
```
Error: Slippage tolerance exceeded
Transaction failed: Price moved beyond slippage tolerance
```

**Possible Causes:**
- Price moved significantly between quote and execution
- Low liquidity pool
- High volatility market conditions
- Slippage tolerance too low

**Solutions:**
1. **Increase Slippage Tolerance:**
   ```javascript
   // Current: 100 bps (1%)
   // Try: 200 bps (2%) or 500 bps (5%)
   const slippageBps = 200; // 2%
   ```

2. **Check Market Conditions:**
   - Verify market is not highly volatile
   - Check liquidity for token pair
   - Consider waiting for better market conditions

3. **Reduce Trade Size:**
   - Smaller trades have less price impact
   - Split large trades into smaller chunks
   - Use limit orders if available

4. **Get Fresh Quote:**
   - Re-fetch quote just before execution
   - Reduce time between quote and execution
   - Use quote expiration time if available

**Prevention:**
- Set appropriate slippage tolerance per token
- Monitor price impact in quote response
- Warn user if price impact is high (>5%)

---

### 6. Network/RPC Connection Issues

**Symptom:**
```
Error: Cannot connect to Jupiter API
Error: getaddrinfo ENOTFOUND
Error: ECONNREFUSED
```

**Possible Causes:**
- Internet connection down
- Jupiter API endpoint changed or deprecated
- RPC endpoint unreachable
- Firewall blocking requests

**Solutions:**
1. **Check Internet Connection:**
   - Verify network connectivity
   - Test other API endpoints
   - Check DNS resolution

2. **Verify API Endpoints:**
   - Jupiter Quote: `https://lite-api.jup.ag/swap/v1/quote`
   - Jupiter Swap: `https://lite-api.jup.ag/swap/v1/swap`
   - Test endpoints with curl or Postman

3. **Check RPC Endpoint:**
   - Verify `SOLANA_RPC_URL` is correct
   - Test RPC with simple query
   - Try alternative RPC provider

4. **Error Handling:**
   ```javascript
   if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
     throw new Error('Cannot connect to Jupiter API. Please check your internet connection.');
   }
   ```

**Prevention:**
- Implement retry logic with exponential backoff
- Use multiple RPC endpoints (fallback)
- Monitor API endpoint health
- Cache quotes when possible

---

### 7. Invalid Transaction Response

**Symptom:**
```
Error: Invalid swap transaction response from Jupiter API
Error: Transaction deserialization failed
```

**Possible Causes:**
- Jupiter API returned malformed response
- Base64 decoding failed
- Transaction format changed

**Solutions:**
1. **Check API Response:**
   ```javascript
   if (!response.data || !response.data.swapTransaction) {
     throw new Error('Invalid swap transaction response');
   }
   ```

2. **Verify Base64 Encoding:**
   ```javascript
   try {
     const swapTransactionBuf = Buffer.from(response.data.swapTransaction, 'base64');
   } catch (error) {
     throw new Error('Failed to decode base64 transaction');
   }
   ```

3. **Check Transaction Format:**
   ```javascript
   try {
     const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
   } catch (error) {
     // Try alternative deserialization method
     const transaction = VersionedTransaction.deserialize(new Uint8Array(swapTransactionBuf));
   }
   ```

**Prevention:**
- Validate API response structure
- Handle different transaction formats
- Log raw response for debugging

---

### 8. Wallet Loading Errors

**Symptom:**
```
Error: SOLANA_PRIVATE_KEY environment variable is not set
Error: Failed to load wallet: Invalid private key length
```

**Possible Causes:**
- Environment variable not set
- Private key format incorrect
- Private key truncated or corrupted

**Solutions:**
1. **Check Environment Variable:**
   ```bash
   # Local
   echo $SOLANA_PRIVATE_KEY
   
   # Vercel
   # Check Settings → Environment Variables
   ```

2. **Verify Private Key Format:**
   - Should be base58 encoded
   - Should be 32 or 64 bytes when decoded
   - No spaces or quotes

3. **Test Key Decoding:**
   ```javascript
   const privateKeyBytes = bs58.decode(privateKeyBase58);
   console.log('Key length:', privateKeyBytes.length); // Should be 32 or 64
   ```

**Prevention:**
- Always validate private key format
- Provide clear error messages
- Document key format requirements

---

### 9. Amount Validation Errors

**Symptom:**
```
Error: Trade amount must be between $0.25 and $1000
Error: Invalid amount: NaN
```

**Possible Causes:**
- Amount input is empty or invalid
- Amount outside allowed range
- Amount parsing failed

**Solutions:**
1. **Frontend Validation:**
   ```javascript
   const amount = parseFloat(amountInput.value);
   if (!amount || amount < 0.25 || amount > 1000) {
     showToast('Trade amount must be between $0.25 and $1000');
     return;
   }
   ```

2. **Backend Validation:**
   ```javascript
   if (amount && amount > maxTradeSize) {
     return res.status(400).json({
       error: 'Trade size exceeds maximum',
       amount,
       maxTradeSize
     });
   }
   ```

3. **Parse Safely:**
   ```javascript
   const amount = amountInput ? parseFloat(amountInput.value) : 0.25;
   if (isNaN(amount) || !isFinite(amount)) {
     // Handle invalid amount
   }
   ```

**Prevention:**
- Validate on both frontend and backend
- Use input type="number" with min/max attributes
- Show clear error messages

---

### 10. Token Decimal Mismatch

**Symptom:**
```
Incorrect entry price calculation
Position size shows wrong amount
```

**Possible Causes:**
- Using wrong decimals for token
- Hardcoded decimals instead of dynamic lookup
- Decimal conversion formula incorrect

**Solutions:**
1. **Use Dynamic Decimals:**
   ```javascript
   // Wrong
   const outputAmountTokens = parseFloat(result.outputAmount) / Math.pow(10, 8);
   
   // Correct
   const tokenDecimals = symbol.includes('SOL') ? 9 : 8;
   const outputAmountTokens = parseFloat(result.outputAmount) / Math.pow(10, tokenDecimals);
   ```

2. **Verify Token Decimals:**
   ```javascript
   const decimals = tokenMapping.getTokenDecimals(symbol);
   console.log(`${symbol} uses ${decimals} decimals`);
   ```

3. **Check All Conversions:**
   - `toTokenAmount()` uses correct decimals
   - `fromTokenAmount()` uses correct decimals
   - Frontend display uses correct decimals

**Prevention:**
- Always use `getTokenDecimals()` function
- Never hardcode decimals
- Test with different tokens (SOL=9, BTC/ETH=8, USDC=6)

---

## Debugging Checklist

When troubleshooting swap issues, check:

- [ ] Environment variables set correctly
- [ ] Wallet has sufficient balance (USDC + SOL for fees)
- [ ] Token addresses are correct
- [ ] Amount calculations use correct decimals
- [ ] Slippage tolerance is appropriate
- [ ] RPC endpoint is accessible
- [ ] Jupiter API endpoints are correct
- [ ] Network connection is stable
- [ ] Transaction signature is valid
- [ ] Logs show detailed error information

---

## Getting Help

1. **Check Logs:**
   - Server logs: `server.log` (local) or Vercel function logs (production)
   - Browser console: Frontend errors and network requests
   - Look for log prefixes: `[JupiterSwap]`, `[TradeExecution]`, etc.

2. **Verify Configuration:**
   - Environment variables in `.env` (local) or Vercel Dashboard (production)
   - Token addresses in `services/tokenMapping.js`
   - API endpoints in `services/jupiterSwap.js`

3. **Test Components:**
   - Test wallet loading: `walletManager.getWallet()`
   - Test token mapping: `tokenMapping.getTokenAddress('BTCUSDT')`
   - Test quote retrieval: `jupiterSwap.getSwapQuote(...)`

4. **Check Documentation:**
   - `docs/SWAP_TECHNICAL_FLOW.md` - Complete flow breakdown
   - `docs/JUPITER_TRADING_INTEGRATION.md` - Integration guide
   - `docs/VERCEL_TRADING_ENV_SETUP.md` - Environment setup

---

## Related Documentation

- `docs/SWAP_TECHNICAL_FLOW.md` - Complete technical flow
- `docs/JUPITER_TRADING_INTEGRATION.md` - Integration guide
- `docs/VERCEL_TRADING_ENV_SETUP.md` - Environment variables


