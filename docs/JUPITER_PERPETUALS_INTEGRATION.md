# Jupiter Perpetuals Integration Documentation

**Last Updated:** 2025-12-03  
**Status:** MVP Implementation Complete

---

## Overview

This document describes the Jupiter Perpetuals integration for leveraged perpetual futures trading. The system supports opening and closing leveraged positions with up to 200x leverage on BTC, ETH, and SOL markets.

---

## Architecture

### Components

1. **services/jupiterPerps.js** - Jupiter Perpetuals API integration
2. **services/positionManager.js** - Position tracking and management
3. **services/tradeExecution.js** - Trade execution orchestrator (updated for perps)
4. **api/execute-trade.js** - API endpoint (updated for perps)
5. **public/index.html** - Frontend UI with perp toggle and leverage controls

### Current Status

- ✅ **Perpetuals Service** - Complete with all required functions
- ✅ **Position Tracking** - In-memory storage with localStorage persistence
- ✅ **Frontend UI** - Perp toggle, leverage selector, margin display
- ⚠️ **On-Chain Integration** - Placeholder implementation (needs actual Jupiter Perps client library)

---

## Setup

### Environment Variables

No additional environment variables required beyond swap setup. Optional:

```bash
# Optional: Jupiter Perps Program ID (if different from default)
JUPITER_PERPS_PROGRAM_ID=your_program_id_here
```

---

## API Endpoints

### POST /api/execute-trade (Updated for Perps)

Execute a perpetual trade based on strategy signal.

**Request Body (Perp Trade):**
```json
{
  "symbol": "BTCUSDT",
  "signal": {
    "valid": true,
    "direction": "long",
    "entryZone": { "min": 90000, "max": 91000 },
    "stopLoss": 88000,
    "targets": [93000, 95000]
  },
  "tradeType": "perp",
  "amount": 100,
  "leverage": 10
}
```

**Response (Perp Trade):**
```json
{
  "success": true,
  "tradeType": "perp",
  "direction": "long",
  "symbol": "BTCUSDT",
  "signature": "transaction_signature_here",
  "positionId": "perp_position_id",
  "leverage": 10,
  "marginRequired": "10.00",
  "size": "100.00",
  "liquidationPrice": 85000,
  "stopLoss": 88000,
  "takeProfit": 93000,
  "explorerUrl": "https://solscan.io/tx/...",
  "timestamp": "2025-12-03T20:00:00.000Z"
}
```

---

## Frontend Usage

### Opening a Perpetual Position

1. **View Signal**: Navigate to a coin with a valid trade signal
2. **Select Trade Type**: Choose "Perpetual" (radio button)
3. **Set Position Size**: Enter position size in USD (default: $0.25)
4. **Select Leverage**: Choose leverage from dropdown (1x-200x)
5. **Review Margin**: Margin required is calculated and displayed automatically
6. **Check Warnings**: High leverage (>10x) shows warning message
7. **Click "Execute Trade"**: Button will show loading state
8. **Monitor Status**: Position details displayed below button
9. **Track Position**: Position automatically tracked in position manager

### Leverage Options

Available leverage levels:
- 1x (no leverage)
- 2x
- 5x
- 10x
- 20x
- 50x
- 100x
- 200x (maximum)

**Safety Warnings:**
- Leverage >10x: Warning displayed in UI
- Leverage >50x: High risk of liquidation
- Leverage 200x: Maximum allowed, extreme risk

### Margin Calculation

**Formula:**
```
Margin Required = Position Size / Leverage
```

**Example:**
- Position Size: $100 USD
- Leverage: 10x
- Margin Required: $100 / 10 = $10 USD

**Minimum Margin:** $0.01 USD

---

## Position Management

### Position Tracking

Positions are automatically tracked when opened:
- Position ID stored
- Entry price, leverage, margin recorded
- Stop loss and take profit levels saved
- P&L calculated and updated

### Position States

- **OPEN** - Active position
- **CLOSED** - Position closed

### Position Data Structure

```typescript
{
  positionId: string;
  symbol: string;
  direction: "long" | "short";
  leverage: number;
  entryPrice: number;
  currentPrice: number | null;
  size: number;
  marginRequired: number;
  liquidationPrice: number;
  stopLoss: number | null;
  targets: number[];
  pnl: number;
  pnlPercent: number;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  fundingFees: number;
}
```

---

## Safety Features

### Leverage Limits

- **Minimum:** 1x (no leverage)
- **Maximum:** 200x
- **Recommended:** 1x-10x for most traders
- **High Risk:** >10x requires warning acknowledgment

### Margin Requirements

- **Minimum Margin:** $0.01 USD
- **Validation:** Checked before position opening
- **Insufficient Margin Error:** Clear error message if margin too low

### Liquidation Risk

- **Liquidation Price:** Calculated and displayed
- **Risk Assessment:** 
  - LOW: >20% from liquidation
  - MEDIUM: 10-20% from liquidation
  - HIGH: 5-10% from liquidation
  - CRITICAL: <5% from liquidation

### Error Handling

**Common Errors:**
- `Leverage must be between 1x and 200x` - Invalid leverage value
- `Insufficient margin` - Margin below minimum
- `Direction must be "long" or "short"` - Invalid direction
- `Position not found` - Position ID doesn't exist

---

## Service Functions

### jupiterPerps.js

**Functions:**
- `getPerpMarkets()` - Get available markets
- `getPerpQuote(market, direction, size, leverage)` - Get position quote
- `openPerpPosition(market, direction, size, leverage, stopLoss, takeProfit)` - Open position
- `closePerpPosition(positionId, size)` - Close position
- `updatePerpPosition(positionId, stopLoss, takeProfit)` - Update SL/TP
- `getPerpPositions(walletAddress)` - Get all positions
- `getPerpPositionDetails(positionId)` - Get position details

### positionManager.js

**Functions:**
- `trackPerpPosition(positionId, signal, leverage, executionResult)` - Track new position
- `getTrackedPositions(symbol)` - Get all tracked positions
- `getPosition(positionId)` - Get specific position
- `updatePerpPositionPnl(positionId)` - Update P&L
- `checkLiquidationRisk(positionId)` - Check liquidation risk
- `closeTrackedPosition(positionId)` - Close tracked position
- `getOpenPositions()` - Get all open positions
- `getClosedPositions()` - Get all closed positions
- `savePositionsToStorage()` - Save to localStorage
- `loadPositionsFromStorage()` - Load from localStorage

---

## Implementation Notes

### Current Implementation Status

**✅ Complete:**
- Service structure and function signatures
- Frontend UI with perp toggle and leverage selector
- Position tracking system
- Error handling and safety checks
- API endpoint integration

**⚠️ Needs Actual Integration:**
- Jupiter Perps client library connection
- On-chain program interaction
- Actual transaction building and signing
- Position querying from blockchain

### Placeholder Implementation

The current `jupiterPerps.js` service uses placeholder implementations that return structured data matching the expected format. These need to be replaced with actual Jupiter Perps client library calls once the exact package and API are verified.

**To Complete Integration:**
1. Verify exact npm package name for Jupiter Perps client
2. Install client library: `npm install @jup-perps/client` (or correct package name)
3. Replace placeholder functions with actual client library calls
4. Test with small positions on mainnet
5. Verify position tracking and P&L calculation

---

## Trading Flow

### Opening a Position

1. User selects "Perpetual" trade type
2. User sets position size and leverage
3. Frontend calculates and displays margin required
4. User clicks "Execute Trade"
5. Frontend sends request to `/api/execute-trade` with leverage
6. API validates leverage and margin requirements
7. API calls `tradeExecution.executePerpTrade()`
8. Service calls `jupiterPerps.openPerpPosition()`
9. Transaction built, signed, and sent to Solana
10. Position ID and transaction signature returned
11. Position automatically tracked in `positionManager`
12. UI displays position details

### Closing a Position

1. User navigates to trade tracker
2. User selects position to close
3. User clicks "Close Position"
4. Frontend calls close position endpoint (to be implemented)
5. Service calls `jupiterPerps.closePerpPosition()`
6. Transaction executed on-chain
7. Position status updated to "CLOSED"
8. Final P&L calculated and displayed

---

## Risk Management

### Leverage Guidelines

| Leverage | Risk Level | Use Case |
|----------|------------|----------|
| 1x-2x | Low | Conservative trading |
| 3x-5x | Medium | Moderate risk |
| 6x-10x | Medium-High | Aggressive trading |
| 11x-50x | High | High risk, experienced traders |
| 51x-200x | Very High | Extreme risk, professional traders only |

### Margin Safety

- Always maintain margin above minimum requirement
- Monitor liquidation price closely
- Use stop losses to limit downside
- Don't use maximum leverage unless experienced
- Consider position size relative to account balance

### Best Practices

1. **Start Small:** Test with minimal position sizes first
2. **Use Stop Losses:** Always set stop loss levels
3. **Monitor Positions:** Regularly check P&L and liquidation risk
4. **Manage Leverage:** Use appropriate leverage for your risk tolerance
5. **Diversify:** Don't put all capital in one position
6. **Understand Funding:** Be aware of funding rate costs

---

## Troubleshooting

### Issue: "Insufficient margin" error

**Cause:** Margin required is below minimum ($0.01)

**Solution:**
- Increase position size
- Reduce leverage
- Ensure amount calculation is correct

### Issue: "Leverage must be between 1x and 200x"

**Cause:** Invalid leverage value

**Solution:**
- Check leverage selector value
- Ensure leverage is a number between 1 and 200
- Verify frontend is sending correct value

### Issue: Position not tracking

**Cause:** Position tracking failed silently

**Solution:**
- Check console logs for tracking errors
- Verify position ID is valid
- Check localStorage for stored positions

### Issue: Liquidation price not showing

**Cause:** Liquidation price calculation failed

**Solution:**
- Verify position details are available
- Check if position is still open
- Refresh position data

---

## Future Enhancements

### Phase 2: Advanced Features

- [ ] Real-time P&L updates
- [ ] Position size adjustments (add/reduce)
- [ ] Partial position closing
- [ ] Multiple positions per symbol
- [ ] Position history and analytics
- [ ] Funding rate tracking
- [ ] Automated stop loss/take profit execution

### Phase 3: Risk Management

- [ ] Portfolio-level risk monitoring
- [ ] Maximum position size limits
- [ ] Leverage limits per user
- [ ] Liquidation alerts
- [ ] Risk score calculation

---

## Related Documentation

- `docs/JUPITER_TRADING_INTEGRATION.md` - Main trading integration guide
- `docs/SWAP_TECHNICAL_FLOW.md` - Swap technical flow (reference)
- `docs/JUPITER_PERPETUALS_RESEARCH.md` - Perps API research notes

---

## Support

For issues or questions:
1. Check console logs for detailed error messages
2. Review Jupiter Perps documentation: https://dev.jup.ag/docs/perps/
3. Verify position data in localStorage
4. Check transaction status on Solscan

---

## Security Notes

⚠️ **High Leverage Risk**: Perpetual futures with high leverage can result in total loss of margin. Always use appropriate risk management.

**Recommendations:**
- Never use more leverage than you can afford to lose
- Always set stop losses
- Monitor positions regularly
- Understand liquidation mechanics
- Start with low leverage to learn


