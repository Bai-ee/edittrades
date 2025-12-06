# Market Capacity Analysis

**Date:** 2025-12-03  
**Status:** Complete Analysis

## Key Finding

**USDT Collateral has capacity, but trading custodies are at limits.**

The `CustodyAmountLimit` error applies to the **trading asset custody** (SOL, ETH, BTC), not the collateral custody (USDT/USDC).

## Market Capacity Results

### Collateral Custodies (✅ These have capacity)
- **USDT Collateral:** 25 assets (essentially empty) ✅ **USE THIS**
- **USDC Collateral:** $238B assets (very high utilization)

### Trading Custodies (⚠️ These are at limits)
- **SOLUSDT Trading Custody:** $5.7B assets (at limit)
- **ETHUSDT Trading Custody:** $306K assets (at limit)
- **BTCUSDT Trading Custody:** $4.8M assets (checking...)

## Understanding the Error

The `CustodyAmountLimit` error (6023) occurs when:
- The **trading asset custody** (SOL, ETH, BTC) reaches its limit
- This is separate from the collateral custody limit
- Even with USDT collateral, if SOL custody is full, you can't open SOL positions

## Market Options Analysis

### ✅ High Probability Markets (Based on Capacity Check)

1. **BTCUSDT with USDT Collateral**
   - BTC custody: $4.8M (lower than SOL's $5.7B)
   - USDT collateral: 25 assets (empty)
   - **Likely has capacity**

2. **ETHUSDT with USDT Collateral**  
   - ETH custody: $306K (lowest of the three)
   - USDT collateral: 25 assets (empty)
   - **May have capacity** (but still hitting limit in tests)

3. **SOLUSDT with USDT Collateral**
   - SOL custody: $5.7B (highest, likely at limit)
   - USDT collateral: 25 assets (empty)
   - **Unlikely to have capacity**

### ⚠️ Alternative Approaches

1. **Wait for Capacity:**
   - Positions close → capacity frees up
   - Protocol admins increase limits
   - Monitor custody assets for changes

2. **Try Different Markets:**
   - BTCUSDT might have more capacity than SOL/ETH
   - Check if other markets are available

3. **Smaller Position Sizes:**
   - Even with limits, very small positions might work
   - Test with $0.01 or smaller

## Current Implementation Status

✅ **Working:**
- USDT collateral selection
- Account creation (funding account, position request ATA)
- Capacity checking
- Error handling

⚠️ **Blocked By:**
- Trading custody limits (SOL, ETH, BTC)
- Protocol-level capacity constraints

## Recommendations

1. **Try BTCUSDT:** Lower custody utilization than SOL/ETH
2. **Monitor Capacity:** Use `checkCustodyCapacity()` to watch for availability
3. **Retry Logic:** Implement automatic retry when capacity becomes available
4. **Contact Jupiter:** Ask about custody limits and when they might increase

## Next Steps

1. Test BTCUSDT specifically (may have more capacity)
2. Implement capacity monitoring/retry logic
3. Add user notification when capacity is available
4. Consider smaller position sizes for testing


