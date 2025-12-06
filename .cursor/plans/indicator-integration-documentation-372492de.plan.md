---
name: Jupiter Trading Integration MVP Plan
overview: ""
todos: []
---

# Jupiter Trading Integration MVP Plan

## Overview

Integrate Jupiter Swap API and Perpetuals API to enable automated trading execution from the frontend. Users can manually execute trades via TRADE button or enable auto-execution when entry prices are hit. MVP supports BTC/ETH/SOL on Solana mainnet with hot wallet for development.

## Architecture

### New Components

1. **services/jupiterSwap.js** - Jupiter Swap API integration (spot token swaps)
2. **services/jupiterPerps.js** - Jupiter Perpetuals API integration (leveraged positions)
3. **services/tradeExecution.js** - Trade execution orchestrator (calls swap/perps based on signal)
4. **services/walletManager.js** - Hot wallet management (dev only, loads from env vars)
5. **api/execute-trade.js** - API endpoint for trade execution
6. **api/auto-execution.js** - Background service for monitoring entry prices (optional)

### Modified Components

1. **public/index.html** - Add TRADE button, auto-execution toggle, trade status UI
2. **server.js** - Add new API routes
3. **package.json** - Add Solana dependencies

## Implementation Strategy

**Phased Approach:**

1. **Phase 1-7: Swap API Integration** - Implement, test, and confirm swap functionality working
2. **Phase 8-10: Perpetuals Integration** - Add perpetual trading after swaps are confirmed working

This ensures we have a working foundation before adding the more complex perpetual trading feature.

## Implementation Steps

### Phase 1: Dependencies & Setup

**Files: package.json**

- Install `@solana/web3.js` (latest version)
- Install `bs58` for base58 encoding/decoding (private keys)
- Add environment variable documentation for `SOLANA_PRIVATE_KEY`, `SOLANA_RPC_URL`, `JUPITER_API_KEY` (optional)

**Files: .env.example (create if doesn't exist)**

- Add `SOLANA_PRIVATE_KEY=your_base58_private_key`
- Add `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com` (or QuickNode/Helius)
- Add `JUPITER_API_KEY=` (optional, for higher rate limits)
- Add `AUTO_EXECUTION_ENABLED=false` (default off for safety)

### Phase 2: Wallet Management

**Files: services/walletManager.js (NEW)**

- Load private key from `process.env.SOLANA_PRIVATE_KEY`
- Decode base58 private key to Uint8Array
- Create Keypair from private key
- Export functions: `getWallet()`, `getWalletAddress()`, `getConnection()`
- Add comprehensive logging for wallet operations
- Add safety checks (warn if using mainnet with real funds in dev)

### Phase 3: Token Mapping

**Files: services/tokenMapping.js (NEW)**

- Map Kraken symbols (BTCUSDT, ETHUSDT, SOLUSDT) to Solana SPL token addresses
- BTC: `So11111111111111111111111111111111111111112` (Wrapped SOL as placeholder, need actual BTC token)
- ETH: Need wrapped ETH token address on Solana
- SOL: Native SOL (use `So11111111111111111111111111111111111111112`)
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Create function: `getTokenAddress(symbol)` returns mint address
- Create function: `getTokenDecimals(symbol)` returns decimals
- Structure for easy extension (add more tokens later)

### Phase 4: Jupiter Swap Integration

**Files: services/jupiterSwap.js (NEW)**

- Implement Jupiter Swap API v6 integration
- Functions:
  - `getSwapQuote(inputMint, outputMint, amount, slippageBps)` - Call Jupiter `/quote` endpoint
  - `buildSwapTransaction(quote, userPublicKey)` - Call Jupiter `/swap` endpoint
  - `executeSwap(transaction, wallet)` - Sign and send transaction
  - `swapTokens(inputMint, outputMint, amountIn, slippageBps, wallet)` - Complete swap flow
- Use Jupiter API base URL: `https://quote-api.jup.ag/v6`
- Handle errors gracefully with detailed logging
- Return transaction signature for tracking

### Phase 5: Jupiter Perpetuals Integration

**Files: services/jupiterPerps.js (NEW)**

- Research Jupiter Perpetuals API endpoints (may need to check latest docs)
- Functions:
  - `openPerpPosition(market, direction, size, leverage, wallet)` - Open leveraged position
  - `closePerpPosition(positionId, wallet)` - Close position
  - `setStopLoss(positionId, stopPrice, wallet)` - Set stop loss
  - `setTakeProfit(positionId, takeProfitPrice, wallet)` - Set take profit
- Handle margin requirements and liquidation risks
- Add comprehensive logging

### Phase 6: Trade Execution Service

**Files: services/tradeExecution.js (NEW)**

- Orchestrate trade execution based on strategy signals
- Functions:
  - `executeTrade(signal, tradeType, wallet)` - Main execution function
    - `tradeType`: 'spot' or 'perp'
    - Convert signal direction (long/short) to swap direction
    - Calculate swap amounts from entry zone
    - Call appropriate service (jupiterSwap or jupiterPerps)
  - `executeStopLoss(signal, entryPrice, wallet)` - Execute stop loss
  - `executeTakeProfit(signal, entryPrice, targetIndex, wallet)` - Execute take profit
- Map strategy signals to Jupiter trade parameters
- Handle partial fills and slippage
- Return execution status and transaction signatures

### Phase 7: API Endpoints

**Files: api/execute-trade.js (NEW)**

- POST `/api/execute-trade`
- Request body: `{ symbol, signal, tradeType, amount?, leverage? }`
- Validate signal (must have valid entryZone, stopLoss, targets)
- Call `tradeExecution.executeTrade()`
- Return: `{ success, txSignature, error? }`
- Add comprehensive logging

**Files: api/auto-execution.js (NEW)**

- Background service (runs on interval or via webhook)
- Monitor active signals for entry price hits
- When entry price hit: call execute-trade endpoint
- Store active signals in memory (or simple file-based storage for MVP)
- Add safety limits (max trades per hour, max position size)

**Files: server.js**

- Add route: `app.post('/api/execute-trade', ...)` - Import and use execute-trade handler
- Add route: `app.get('/api/trade-status/:txSignature', ...)` - Check transaction status
- Ensure CORS is enabled for new endpoints

### Phase 8: Frontend Integration

**Files: public/index.html**

- Add TRADE button next to each valid signal in the details view
- Button should be:
  - Visible only when `signal.valid === true`
  - Disabled during execution
  - Show loading state during execution
- Add trade type selector (Spot Swap / Perpetual) - default to Spot
- Add auto-execution toggle (checkbox) - default OFF
- Add trade status display (pending, executing, success, error)
- Add transaction signature link (Solscan explorer)
- Functions:
  - `executeTrade(symbol, signal, tradeType)` - Call `/api/execute-trade`
  - `enableAutoExecution(symbol, signal)` - Enable auto-execution for this signal
  - `disableAutoExecution(symbol)` - Disable auto-execution
  - `checkTradeStatus(txSignature)` - Poll transaction status
- Update UI to show execution status
- Add error handling and user feedback

### Phase 9: Testing & Safety

**Files: test-jupiter-integration.js (NEW)**

- Test wallet connection
- Test token mapping
- Test swap quote retrieval (no execution)
- Test transaction building (no signing)
- Test with small amounts on devnet first (if possible)
- Add comprehensive logging at each step

**Safety Measures:**

- Add confirmation dialog before executing trades
- Add maximum trade size limits (configurable)
- Add rate limiting (max trades per hour)
- Log all trade executions to file
- Add dry-run mode (test without executing)
- Warn user if using mainnet with real funds

### Phase 10: Documentation

**Files: docs/JUPITER_TRADING_INTEGRATION.md (NEW)**

- Document setup process (wallet, API keys, RPC)
- Document trade execution flow
- Document auto-execution behavior
- Document token mapping and extension
- Document safety measures and limits
- Document error handling

## Critical Considerations

1. **No Breaking Changes**: All existing strategy evaluation code remains untouched. Trading is additive functionality.

2. **Error Handling**: Every Jupiter API call must have try-catch with detailed logging. Failures should not crash the system.

3. **Logging**: Add console.log at every step:

   - Wallet loaded
   - Quote retrieved
   - Transaction built
   - Transaction signed
   - Transaction sent
   - Transaction confirmed

4. **Testing Strategy**: 

   - Start with quote-only calls (no execution)
   - Then test transaction building (no signing)
   - Then test with minimal amounts
   - Finally test full flow

5. **Token Support**: MVP supports BTC/ETH/SOL. Architecture allows easy extension via tokenMapping.js.

6. **Auto-Execution**: Should be opt-in, clearly labeled, with confirmation. Monitor entry prices via polling or webhook.

## File Structure

```
services/
  ├── jupiterSwap.js (NEW)
  ├── jupiterPerps.js (NEW)
  ├── tradeExecution.js (NEW)
  ├── walletManager.js (NEW)
  └── tokenMapping.js (NEW)

api/
  ├── execute-trade.js (NEW)
  └── auto-execution.js (NEW)

public/
  └── index.html (MODIFIED - add TRADE button, auto-exec toggle)

docs/
  └── JUPITER_TRADING_INTEGRATION.md (NEW)
```

## Dependencies to Add

```json
{
  "@solana/web3.js": "^1.87.0",
  "bs58": "^5.0.0"
}
```

## Environment Variables

- `SOLANA_PRIVATE_KEY` - Base58 encoded private key (hot wallet)
- `SOLANA_RPC_URL` - Solana RPC endpoint (QuickNode/Helius recommended)
- `JUPITER_API_KEY` - Optional, for higher rate limits
- `AUTO_EXECUTION_ENABLED` - Default false
- `MAX_TRADE_SIZE_USD` - Safety limit
- `MAX_TRADES_PER_HOUR` - Rate limit