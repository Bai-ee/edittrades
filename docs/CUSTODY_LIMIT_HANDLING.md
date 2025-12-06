# Custody Amount Limit Handling

**Date:** 2025-12-03  
**Status:** Documentation and Error Handling Guide

## Understanding CustodyAmountLimit Error

The `CustodyAmountLimit` error (Error Code: 6023) occurs when a transaction exceeds the allowed amount for a specific custody account in Jupiter Perpetuals. This is a **protocol-level safety mechanism** to manage risk and ensure platform stability.

## Error Details

- **Error Code:** 6023
- **Error Name:** `CustodyAmountLimit`
- **Error Message:** "Custody amount limit exceeded"
- **Location:** `programs/perpetuals/src/state/position.rs:120`

## Custody Account Structure

Each custody account in Jupiter Perpetuals has:
- **Pool Association:** The public key of the pool
- **Mint Address:** The token's mint account
- **Amount Limit:** Maximum allowed assets for the custody
- **Assets Owned:** Current assets in the custody
- **Funding Rate State:** Cumulative interest rates and hourly funding rates

## How to Check Custody Limits

### 1. Fetch Custody Account Data

```javascript
import { fetchCustody } from 'jup-perps-client';

const custody = await fetchCustody(rpc, custodyAddress);

// Check limits
if (custody.data.amountLimit) {
  const limitUsd = Number(custody.data.amountLimit) / 1_000_000;
  const currentUsd = Number(custody.data.assets.owned) / 1_000_000;
  const availableUsd = limitUsd - currentUsd;
  
  console.log('Custody Limit (USD):', limitUsd);
  console.log('Current Assets (USD):', currentUsd);
  console.log('Available Capacity (USD):', availableUsd);
}
```

### 2. Validate Before Trading

Before attempting to open a position, check if there's sufficient capacity:

```javascript
async function checkCustodyCapacity(custodyAddress, requiredSizeUsd) {
  const custody = await fetchCustody(rpc, custodyAddress);
  
  if (!custody.data.amountLimit) {
    console.warn('Custody limit not available');
    return { available: true, reason: 'Limit not available' };
  }
  
  const limitUsd = Number(custody.data.amountLimit) / 1_000_000;
  const currentUsd = Number(custody.data.assets.owned) / 1_000_000;
  const availableUsd = limitUsd - currentUsd;
  
  if (requiredSizeUsd > availableUsd) {
    return {
      available: false,
      limit: limitUsd,
      current: currentUsd,
      available: availableUsd,
      required: requiredSizeUsd,
      reason: 'Insufficient custody capacity'
    };
  }
  
  return {
    available: true,
    limit: limitUsd,
    current: currentUsd,
    available: availableUsd,
    required: requiredSizeUsd
  };
}
```

## Error Handling Best Practices

### 1. Graceful Error Handling

```javascript
try {
  const result = await openPerpPosition(market, direction, size, leverage);
  return result;
} catch (error) {
  if (error.message.includes('CustodyAmountLimit') || 
      error.message.includes('6023')) {
    // Handle custody limit error specifically
    console.warn('Custody limit exceeded. Checking capacity...');
    
    const capacity = await checkCustodyCapacity(custodyAddress, size);
    if (!capacity.available) {
      throw new Error(
        `Custody limit exceeded. ` +
        `Available: $${capacity.available.toFixed(2)}, ` +
        `Required: $${capacity.required.toFixed(2)}. ` +
        `Please try a smaller position size or wait for capacity.`
      );
    }
  }
  throw error;
}
```

### 2. User-Friendly Error Messages

```javascript
function formatCustodyLimitError(error, custodyData) {
  if (error.message.includes('CustodyAmountLimit')) {
    const limit = custodyData?.amountLimit 
      ? Number(custodyData.amountLimit) / 1_000_000 
      : 'unknown';
    const current = custodyData?.assets?.owned 
      ? Number(custodyData.assets.owned) / 1_000_000 
      : 'unknown';
    
    return {
      error: 'CustodyLimitExceeded',
      message: `The custody account has reached its capacity limit.`,
      details: {
        limit: limit,
        current: current,
        suggestion: 'Please try a smaller position size or wait for capacity to become available.'
      }
    };
  }
  return null;
}
```

## Resources

### Documentation
- [Custody Account Documentation](https://dev.jup.ag/docs/perps/custody-account)
- [Position Account Documentation](https://dev.jup.ag/docs/perps/position-account)
- [PositionRequest Account Documentation](https://dev.jup.ag/docs/perps/position-request-account)

### IDL and Examples
- [Jupiter Perpetuals IDL](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing/tree/main/src/idl)
- [TypeScript Examples](https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing/tree/main/src/examples)

### Community Support
- [Jupiter Discord](https://discord.gg/jupiter) - For technical support and questions

## Implementation Status

✅ **Current Implementation:**
- Custody data fetching is implemented
- Basic limit logging is in place
- Error detection for CustodyAmountLimit is working

⏳ **Recommended Enhancements:**
1. Add pre-trade capacity checking
2. Implement automatic retry with smaller sizes
3. Add user-friendly error messages
4. Create capacity monitoring dashboard

## Notes

- Custody limits are set by the protocol administrators
- Limits can change over time as the protocol evolves
- Different markets may have different limits
- Limits are enforced to maintain protocol stability and risk management


