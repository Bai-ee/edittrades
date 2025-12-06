# Perpetuals Provider Integration Documentation

**Date:** 2025-12-03  
**Status:** Implementation Complete - Ready for Testing

## Overview

The system now supports multiple perpetuals providers with automatic fallback logic. Jupiter Perpetuals has been replaced with a unified provider interface that tries Drift Protocol first, then Mango Markets, then Jupiter as a last resort.

## Architecture

### Provider Priority Order

1. **Drift Protocol** (Primary)
   - Up to 101x leverage
   - $600M open interest, $300M daily volume
   - Best liquidity and capacity

2. **Mango Markets** (Fallback)
   - Up to 20x leverage
   - Cross-margining system
   - Good alternative if Drift has issues

3. **Jupiter Perpetuals** (Last Resort)
   - Up to 200x leverage
   - Currently hitting capacity limits
   - Kept as fallback option

### File Structure

```
services/
  ├── driftPerps.js          # Drift Protocol integration
  ├── mangoPerps.js          # Mango Markets integration
  ├── jupiterPerps.js        # Jupiter Perpetuals (kept as fallback)
  ├── perpsProvider.js       # Unified provider interface
  └── tradeExecution.js      # Updated to use provider interface
```

## Usage

### Automatic Provider Selection (Recommended)

```javascript
import * as perpsProvider from './services/perpsProvider.js';

// Automatically tries Drift → Mango → Jupiter
const result = await perpsProvider.openPerpPosition(
  'auto',           // Auto-select with fallback
  'SOLUSDT',        // Market
  'long',           // Direction
  100,              // Size (USD)
  10,               // Leverage
  stopLoss,         // Optional
  takeProfit        // Optional
);
```

### Manual Provider Selection

```javascript
// Use specific provider
const result = await perpsProvider.openPerpPosition(
  'drift',          // Specific provider
  'SOLUSDT',
  'long',
  100,
  10
);
```

## Provider Functions

All providers implement the same interface:

- `getPerpMarkets()` - Get available markets
- `getPerpQuote()` - Get quote for position
- `openPerpPosition()` - Open position
- `closePerpPosition()` - Close position
- `getPerpPositions()` - Get user positions

## Fallback Logic

The provider interface automatically handles fallbacks:

1. **Capacity Errors**: If a provider hits capacity limits, automatically tries next provider
2. **Connection Errors**: If a provider fails to connect, tries next provider
3. **All Providers Fail**: Returns comprehensive error with all provider errors

## Integration with Trade Execution

The `tradeExecution.js` service now uses the provider interface:

```javascript
// Old (direct Jupiter call)
const result = await jupiterPerps.openPerpPosition(...);

// New (provider interface with fallback)
const result = await perpsProvider.openPerpPosition('auto', ...);
```

## Provider-Specific Notes

### Drift Protocol

- **SDK**: `@drift-labs/sdk` (v2.151.0-beta.3)
- **Leverage**: 1x - 101x
- **Markets**: 100+ perpetual markets
- **Status**: Primary provider, best capacity

### Mango Markets

- **SDK**: `@blockworks-foundation/mango-v4` (v0.33.9)
- **Leverage**: 1x - 20x
- **Markets**: Major crypto pairs
- **Status**: Fallback provider

### Jupiter Perpetuals

- **SDK**: `jup-perps-client` (v1.1.0)
- **Leverage**: 1x - 200x
- **Markets**: SOL, BTC, ETH
- **Status**: Last resort (capacity issues)

## Error Handling

The provider interface handles errors gracefully:

- **Capacity Limits**: Automatically tries next provider
- **Connection Issues**: Falls back to next provider
- **Invalid Markets**: Returns clear error message
- **All Providers Fail**: Returns comprehensive error

## Testing

To test the integration:

```javascript
// Test automatic selection
const result = await perpsProvider.openPerpPosition('auto', 'SOLUSDT', 'long', 1, 1);

// Test specific provider
const driftResult = await perpsProvider.openPerpPosition('drift', 'SOLUSDT', 'long', 1, 1);
const mangoResult = await perpsProvider.openPerpPosition('mango', 'SOLUSDT', 'long', 1, 1);
```

## Migration Notes

- **Jupiter Swaps**: Unchanged - still uses `jupiterSwap.js`
- **Jupiter Perps**: Now accessed through provider interface
- **Backward Compatibility**: Provider interface maintains same function signatures
- **Position Tracking**: May need to track which provider was used for each position

## Next Steps

1. Test with small positions ($0.10 - $1)
2. Verify capacity availability on Drift and Mango
3. Test fallback logic when providers fail
4. Update position tracking to include provider info
5. Add provider selection UI option (optional)


