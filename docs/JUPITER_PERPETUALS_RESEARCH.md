# Jupiter Perpetuals API Research

**Last Updated:** 2025-12-03  
**Status:** Research Complete - Implementation Ready

---

## Confirmed Information

### ✅ Jupiter Perpetuals Exists
- Separate from Jupiter Swap API
- On-chain Solana program
- Supports perpetual futures trading with leverage

### ✅ Leverage Limits
- **Maximum Leverage:** Up to 250x (confirmed)
- **Target Leverage:** 200x (feasible and within limits)
- **Default Leverage:** 1x (no leverage)

### ✅ Architecture
- **Request Fulfillment Model:** On-chain trade requests fulfilled by keepers
- **Liquidity Model:** JLP (Jupiter Liquidity Pool) provides liquidity
- **Program Type:** Solana program (on-chain)

### ✅ Client Libraries
- **TypeScript Client:** Available (github.com/monakki/jup-perps-client)
- **Rust Client:** Available (lib.rs/crates/jup-perps-client)
- **IDL-Based:** Generated from program IDL

---

## API Documentation Sources

1. **Jupiter Developers Docs:** https://dev.jup.ag/docs/perps/
2. **API Reference:** https://dev.jup.ag/api-reference
3. **Support Docs:** https://support.jup.ag/hc/en-us/articles/18734952106908-Perps-Quickstart

---

## Key Concepts

### Pool Account
- Manages liquidity pool parameters
- Tracks pool state and balances

### Custody Account
- Each asset has a custody account
- Manages asset-specific parameters
- Tracks collateral and positions

### Position Management
- Open positions with leverage
- Close positions (full or partial)
- Update stop loss/take profit
- Query position details

### Margin Requirements
- Initial margin required to open position
- Maintenance margin to keep position open
- Liquidation threshold

---

## Implementation Approach

Since the exact npm package name and API endpoints need verification, we'll implement:

1. **Flexible Service Structure:** Following same pattern as `jupiterSwap.js`
2. **On-Chain Interaction:** Use `@solana/web3.js` for program interaction
3. **IDL-Based Client:** Generate or use TypeScript client from IDL
4. **REST API (if available):** Similar to swap API structure

---

## Next Steps

1. Verify exact npm package name for TypeScript client
2. Obtain Jupiter Perps program ID
3. Get IDL for program interaction
4. Test API endpoints (if REST API exists)
5. Implement service following swap pattern

---

## Notes

- Jupiter Perps uses on-chain program, not REST API like swaps
- May need to use Solana program interaction instead of HTTP requests
- Client library will handle program interaction details
- Follow same error handling and logging patterns as swap service


