# Solana Perpetuals Alternatives Research

**Date:** 2025-12-03  
**Status:** Research Complete - Ready for Implementation

## Problem Statement

Jupiter Perpetuals is hitting `CustodyAmountLimit` errors on all major markets (SOL, BTC, ETH) due to protocol-level capacity constraints. Need alternative Solana perpetuals platforms with available capacity.

## Platform Comparison

### 1. Drift Protocol ⭐ **RECOMMENDED**

**SDK Availability:**
- ✅ `@drift-labs/sdk` (npm) - Version 2.151.0-beta.3
- ✅ TypeScript SDK with comprehensive documentation
- ✅ Active development (updated 2025-12-03)

**Features:**
- $600M open interest, $300M daily volume
- Up to 101x leverage (20x standard, 101x in High Leverage Mode)
- 100+ perpetual markets (BTC, ETH, SOL, etc.)
- Hybrid liquidity: Order book + AMM + JIT liquidity auctions
- Cross-margin trading
- 20+ collateral tokens supported
- Deep liquidity, low slippage

**Capacity:**
- High liquidity and open interest
- Likely has capacity for small-medium positions
- Active trading volume indicates healthy markets

**Integration Complexity:** Medium
- Well-documented SDK
- TypeScript support
- Similar patterns to Jupiter Perps

**Recommendation:** **PRIMARY CHOICE** - Most established, best SDK, highest liquidity

---

### 2. Mango Markets

**SDK Availability:**
- ✅ `@blockworks-foundation/mango-v4` (npm) - Version 0.33.9
- ✅ TypeScript SDK
- ✅ Active development (updated 2024-12-10)

**Features:**
- Up to 20x leverage
- Cross-margining system (single collateral pool for multiple markets)
- Unique oracle design (off-chain + on-chain order book)
- Advanced risk management (automated liquidations, dynamic interest rates)
- Major crypto pairs supported

**Capacity:**
- Established platform with good liquidity
- Cross-margining may help with capacity

**Integration Complexity:** Medium
- SDK available
- Different architecture than Jupiter/Drift

**Recommendation:** **FALLBACK OPTION** - Good alternative if Drift has issues

---

### 3. Raydium (via Orderly Network)

**API Availability:**
- ⚠️ Orderly Network API (REST-based)
- ⚠️ Less direct SDK support
- ⚠️ May require REST API integration

**Features:**
- 70+ trading pairs
- Up to 40x leverage
- 0% maker fees, 0.025% taker fees (beta)
- Gas-free trading
- Partnership with Raydium

**Capacity:**
- Good number of trading pairs
- Beta status may indicate capacity

**Integration Complexity:** Higher
- REST API instead of SDK
- Different integration pattern

**Recommendation:** **TERTIARY OPTION** - Consider if SDK-based options fail

---

### 4. Perp.run

**SDK Availability:**
- ❓ Unknown SDK availability
- ⚠️ Less established platform

**Features:**
- Up to 100x leverage
- Non-custodial
- Sub-second transaction finality
- Minimal fees

**Capacity:**
- Unknown capacity status

**Integration Complexity:** Unknown
- SDK availability unclear

**Recommendation:** **NOT RECOMMENDED** - Insufficient information

---

## Implementation Strategy

### Phase 1: Drift Protocol (Primary)
1. Install `@drift-labs/sdk`
2. Create `services/driftPerps.js`
3. Implement core functions:
   - `getDriftMarkets()`
   - `getDriftQuote()`
   - `openDriftPosition()`
   - `closeDriftPosition()`
   - `getDriftPositions()`

### Phase 2: Mango Markets (Fallback)
1. Install `@blockworks-foundation/mango-v4`
2. Create `services/mangoPerps.js`
3. Implement similar function set

### Phase 3: Unified Provider Interface
1. Create `services/perpsProvider.js`
2. Implement provider selection logic
3. Add fallback mechanism (Drift → Mango → Jupiter)

### Phase 4: Integration
1. Update `services/tradeExecution.js`
2. Replace Jupiter Perps calls with provider interface
3. Keep Jupiter Swaps unchanged

## Decision Matrix

| Platform | SDK Quality | Capacity | Liquidity | Leverage | Integration Ease | Recommendation |
|----------|-------------|----------|-----------|----------|-------------------|----------------|
| **Drift** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 101x | ⭐⭐⭐⭐ | **PRIMARY** |
| **Mango** | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | 20x | ⭐⭐⭐ | **FALLBACK** |
| **Raydium** | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | 40x | ⭐⭐ | **TERTIARY** |
| **Perp.run** | ❓ | ❓ | ❓ | 100x | ❓ | **SKIP** |

## Next Steps

1. ✅ Research complete
2. ⏳ Implement Drift Protocol integration
3. ⏳ Implement Mango Markets integration
4. ⏳ Create unified provider interface
5. ⏳ Update trade execution system
6. ⏳ Test with small positions
7. ⏳ Document integration


