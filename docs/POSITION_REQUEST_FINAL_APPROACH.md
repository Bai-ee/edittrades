# Position Request PDA - Final Approach

**Date:** 2025-12-03  
**Status:** ⚠️ Still unresolved - Need to check actual GitHub repository code

## Current Situation

We've tried multiple seed combinations based on documentation and search results:
1. `[b"position_request", position, counter]` - Based on Jupiter docs
2. `[b"position_request", owner, pool, custody, counter]` - Based on search results
3. `[b"position_request", owner, pool, custody, position, counter]` - Including position
4. `[b"position_request", perpetuals, pool, owner, position, counter]` - Including perpetuals

**None of these match what the program expects.**

## Key Observation

The program's expected PDA ("Right" value) **changes with each transaction**, which suggests:
- The program might be deriving it internally based on instruction data
- The counter might be calculated by the program, not provided by us
- The account might be created by the program itself

## Next Steps

1. **Check the actual GitHub repository code:**
   - Clone or browse: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
   - Look for `createIncreasePositionMarketRequest` examples
   - Find how they derive or pass the positionRequest account

2. **Check if program creates the account:**
   - Try passing `positionRequest: null` (if allowed)
   - Check if the instruction has `init_if_needed` or similar
   - Verify if systemProgram is used to create the account

3. **Query existing position requests:**
   - Find actual PositionRequest accounts on-chain
   - Reverse-engineer their derivation
   - Compare with our attempts

## Files to Check

- `services/jupiterPerps.js` - Current implementation
- `test-perp-trade.js` - Test script
- GitHub repo: `julianfssen/jupiter-perps-anchor-idl-parsing`


