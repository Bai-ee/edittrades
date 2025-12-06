# Jupiter Trading Integration Documentation

**Last Updated:** 2025-12-03  
**Status:** MVP - Swap API Integration Complete, Perpetuals Pending

---

## Overview

This document describes the Jupiter trading integration for automated trade execution from the frontend. The system supports spot token swaps via Jupiter Aggregator API, with perpetual trading support planned for future phases.

## Architecture

### Components

1. **services/walletManager.js** - Solana wallet/keypair management
2. **services/tokenMapping.js** - Maps trading symbols to Solana token addresses
3. **services/jupiterSwap.js** - Jupiter Swap API integration
4. **services/tradeExecution.js** - Trade execution orchestrator
5. **api/execute-trade.js** - API endpoint for trade execution
6. **public/index.html** - Frontend UI with TRADE button

### Current Status

- ✅ **Swap API Integration** - Complete and tested
- ✅ **Perpetuals Integration** - MVP Complete (needs client library connection)

---

## Setup

### 1. Environment Variables

Create a `.env` file with the following variables:

```bash
# Solana Configuration
SOLANA_PRIVATE_KEY=your_base58_private_key_here
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Jupiter API (Optional - free tier works without key)
JUPITER_API_KEY=

# Trading Configuration
AUTO_EXECUTION_ENABLED=false
MAX_TRADE_SIZE_USD=1000
MAX_TRADES_PER_HOUR=10
```

### 2. Generate Solana Wallet

**Option A: Using Solana CLI**
```bash
solana-keygen new --outfile ~/.config/solana/id.json
# Extract private key (first 32 bytes as base58)
```

**Option B: Using Node.js**
```javascript
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const keypair = Keypair.generate();
const privateKeyBase58 = bs58.encode(keypair.secretKey.slice(0, 32));
console.log('Private Key (base58):', privateKeyBase58);
console.log('Public Key:', keypair.publicKey.toBase58());
```

### 3. Fund Wallet

Ensure your wallet has sufficient SOL for:
- Transaction fees (~0.000005 SOL per transaction)
- Trade amounts (if trading with SOL)
- Small buffer for failed transactions

**Recommended:** Start with 0.1-0.5 SOL for testing.

---

## API Endpoints

### POST /api/execute-trade

Execute a trade based on strategy signal.

**Request Body:**
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
  "tradeType": "spot",
  "amount": 100
}
```

**Response:**
```json
{
  "success": true,
  "tradeType": "spot",
  "direction": "long",
  "symbol": "BTCUSDT",
  "signature": "transaction_signature_here",
  "explorerUrl": "https://solscan.io/tx/...",
  "inputAmount": "100000000",
  "outputAmount": "95000000",
  "priceImpact": "0.5"
}
```

### GET /api/trade-status/:signature

Check transaction status on Solana.

**Response:**
```json
{
  "success": true,
  "signature": "transaction_signature_here",
  "status": {
    "confirmed": "confirmed",
    "err": null,
    "slot": 123456789
  }
}
```

---

## Technical Architecture

### Complete Swap Execution Flow

**See:** `docs/SWAP_TECHNICAL_FLOW.md` for complete technical breakdown

**High-Level Flow:**
1. Frontend → API Endpoint (`/api/execute-trade`)
2. API → Trade Execution Service (`services/tradeExecution.js`)
3. Trade Execution → Token Mapping (`services/tokenMapping.js`)
4. Trade Execution → Jupiter Swap (`services/jupiterSwap.js`)
5. Jupiter Swap → Jupiter API (quote → build → execute)
6. Jupiter Swap → Solana RPC (sign → send → confirm)
7. Response → Frontend (display status, track trade)

### Request/Response Schemas

**Request Schema:**
```json
{
  "symbol": "BTCUSDT",
  "signal": {
    "valid": true,
    "direction": "long",
    "symbol": "BTCUSDT",
    "entryZone": { "min": 90000, "max": 91000 },
    "stopLoss": 88000,
    "targets": [93000, 95000],
    "currentPrice": 90500
  },
  "tradeType": "spot",
  "amount": 0.25
}
```

**Response Schema:**
```json
{
  "success": true,
  "tradeType": "spot",
  "direction": "long",
  "symbol": "BTCUSDT",
  "signature": "transaction_signature_base58",
  "explorerUrl": "https://solscan.io/tx/...",
  "inputAmount": "250000",
  "outputAmount": "7993",
  "priceImpact": "0",
  "signal": {
    "entryZone": { "min": 90000, "max": 91000 },
    "stopLoss": 88000,
    "targets": [93000, 95000]
  },
  "timestamp": "2025-12-03T20:00:00.000Z"
}
```

### Token Decimal Handling

**Token Decimals:**
- **SOL**: 9 decimals (1 SOL = 1,000,000,000 lamports)
- **BTC**: 8 decimals (1 BTC = 100,000,000 smallest units)
- **ETH**: 8 decimals (1 ETH = 100,000,000 smallest units)
- **USDC**: 6 decimals (1 USDC = 1,000,000 smallest units)
- **USDT**: 6 decimals (1 USDT = 1,000,000 smallest units)

**Conversion Functions:**
- `toTokenAmount(amount, symbol)` - Human-readable → Smallest unit
- `fromTokenAmount(amount, symbol)` - Smallest unit → Human-readable

**Example:**
```javascript
// $0.25 USDC → smallest units
const usdcAmount = toTokenAmount(0.25, 'USDC'); // 250,000

// 7,993 WETH smallest units → human-readable
const ethAmount = fromTokenAmount(7993, 'ETHUSDT'); // 0.00007993
```

### Amount Calculation Formulas

**Long Trade (Buy Token with USDC):**
```
amountInSmallestUnit = amountUSD * 10^6  // USDC has 6 decimals
inputMint = USDC address
outputMint = Base token address
```

**Short/Sell Trade (Sell Token for USDC):**
```
currentPrice = signal.currentPrice || (entryZone.min + entryZone.max) / 2
tokenAmount = (amountUSD / currentPrice) * 1.01  // 1% buffer for slippage
amountInSmallestUnit = tokenAmount * 10^decimals  // 8 or 9 decimals
inputMint = Base token address
outputMint = USDC address
```

### Slippage and Price Impact

**Slippage Tolerance:**
- Default: 100 basis points (1%)
- Configurable per trade
- Applied to Jupiter quote request

**Price Impact:**
- Provided by Jupiter API in quote response
- Displayed to user in trade status
- High impact (>5%) indicates low liquidity

**Formula:**
```
slippageBps = 100  // 1% = 100 basis points
priceImpact = quote.priceImpactPct  // From Jupiter API
```

### Transaction Lifecycle

**States:**
1. **Pending** - Transaction sent, awaiting confirmation
2. **Processing** - Transaction in block, being processed
3. **Confirmed** - Transaction confirmed by supermajority
4. **Finalized** - Transaction finalized (irreversible)

**Polling:**
- Poll `/api/trade-status/:signature` every 10 seconds
- Maximum 30 attempts (5 minutes)
- Stop on confirmation or error

### Buy vs Sell Flow Differences

**Buy (Long) Flow:**
1. User enters USD amount
2. Convert USD → USDC smallest units (6 decimals)
3. Swap: USDC → Base Token
4. Receive tokens in wallet
5. Calculate entry price: `inputAmountUSD / outputAmountTokens`

**Sell (Short) Flow:**
1. User enters USD amount to sell
2. Calculate token amount: `(amountUSD / currentPrice) * 1.01`
3. Convert token amount → smallest units (8 or 9 decimals)
4. Swap: Base Token → USDC
5. Receive USDC in wallet
6. Entry price: From original buy trade

---

## Frontend Usage

### Manual Trade Execution

1. **View Signal**: Navigate to a coin with a valid trade signal
2. **Select Trade Type**: Choose "Spot Swap" (Perpetuals coming soon)
3. **Set Amount**: Enter trade amount in USD (default: $0.25, min: $0.25, max: $1000)
4. **Click "Execute Trade"**: Button will show loading state
5. **Monitor Status**: Transaction status displayed below button
6. **View on Explorer**: Click link to view transaction on Solscan
7. **Track Trade**: Click "Track Trade" button to add to trade tracker

### Auto-Execution

1. **Enable Toggle**: Check "Auto-execute when entry price is hit"
2. **Set Parameters**: Configure trade type and amount
3. **Monitor**: System will execute when price enters entry zone
4. **Disable**: Uncheck toggle to disable auto-execution

**Note:** Auto-execution requires active price monitoring. Currently manual trigger only.

---

## Token Support

### MVP Tokens (Currently Supported)

- **SOL** - Native Solana
- **BTC** - Wrapped Bitcoin (WBTC on Solana)
- **ETH** - Wrapped Ethereum (WETH on Solana)
- **USDC** - USD Coin

### Adding New Tokens

Edit `services/tokenMapping.js`:

```javascript
TOKEN_ADDRESSES['NEWTOKEN'] = 'token_mint_address_here';
TOKEN_DECIMALS['NEWTOKEN'] = 9; // Adjust decimals
```

---

## Testing

### Run Integration Tests

```bash
node test-jupiter-integration.js
```

This will test:
- ✅ Wallet loading and verification
- ✅ Token mapping
- ✅ Swap quote retrieval (no execution)
- ✅ Transaction building (no signing)

### Test with Small Amounts

1. Set `MAX_TRADE_SIZE_USD=10` in `.env`
2. Use test wallet with minimal funds
3. Execute small trades first
4. Monitor transaction fees

---

## Safety Measures

### Built-in Protections

1. **Maximum Trade Size**: Configurable via `MAX_TRADE_SIZE_USD`
2. **Rate Limiting**: `MAX_TRADES_PER_HOUR` prevents excessive trading
3. **Signal Validation**: All signals validated before execution
4. **Error Handling**: Comprehensive try-catch with detailed logging
5. **Confirmation Required**: Manual button click required (auto-execution is opt-in)

### Best Practices

1. **Start Small**: Test with minimal amounts first
2. **Monitor Fees**: Transaction fees can add up
3. **Check Rate Limits**: Jupiter free tier: 60 requests/minute
4. **Use Test Wallet**: Don't use main wallet for development
5. **Review Logs**: Check console logs for detailed execution info

---

## Error Handling

### Common Errors

**"SOLANA_PRIVATE_KEY environment variable is not set"**
- Solution: Add `SOLANA_PRIVATE_KEY` to `.env` file

**"Token address not found for symbol"**
- Solution: Add token mapping in `services/tokenMapping.js`

**"Trade size exceeds maximum"**
- Solution: Reduce trade amount or increase `MAX_TRADE_SIZE_USD`

**"Jupiter API rate limit exceeded"**
- Solution: Wait 60 seconds or upgrade to Pro tier

**"Transaction failed"**
- Solution: Check wallet balance, RPC connection, and transaction logs

---

## Logging

All trade operations are logged with prefixes:

- `[WalletManager]` - Wallet operations
- `[TokenMapping]` - Token address resolution
- `[JupiterSwap]` - Swap API calls
- `[TradeExecution]` - Trade orchestration
- `[ExecuteTrade]` - API endpoint
- `[Frontend]` - Frontend operations

---

## Perpetuals Trading

### Overview

The system now supports perpetual futures trading via Jupiter Perpetuals with leverage up to 200x. See `docs/JUPITER_PERPETUALS_INTEGRATION.md` for complete documentation.

### Quick Start

1. Select "Perpetual" trade type in UI
2. Set position size (USD)
3. Choose leverage (1x-200x)
4. Review margin required (auto-calculated)
5. Execute trade

### Key Features

- **Leverage:** 1x to 200x
- **Markets:** BTC, ETH, SOL
- **Position Tracking:** Automatic tracking with P&L calculation
- **Safety:** Margin validation, leverage warnings, liquidation risk monitoring

### Comparison: Spot vs Perps

| Feature | Spot Swap | Perpetuals |
|---------|-----------|------------|
| Leverage | None (1x) | 1x-200x |
| Position Size | Limited by capital | Amplified by leverage |
| Margin Required | Full amount | Amount / Leverage |
| Liquidation Risk | None | Yes (if margin insufficient) |
| Funding Fees | None | Yes (periodic) |
| Use Case | Direct token ownership | Leveraged speculation |

## Future Enhancements

### Phase 2: Advanced Perpetuals Features

- [ ] Real-time P&L updates
- [ ] Position size adjustments
- [ ] Partial position closing
- [ ] Multiple positions per symbol
- [ ] Automated stop loss/take profit execution

### Phase 3: Advanced Features

- [ ] Position tracking
- [ ] P&L calculation
- [ ] Trade history
- [ ] Performance analytics
- [ ] Multi-wallet support

---

## Troubleshooting

### Issue: Wallet not loading

**Check:**
- Private key format (should be base58, 32 or 64 bytes)
- Environment variable is set correctly
- `.env` file is in project root

### Issue: Swap quote fails

**Check:**
- Token addresses are correct
- Amount is in smallest unit (lamports/wei)
- Jupiter API is accessible
- Rate limits not exceeded

### Issue: Transaction fails

**Check:**
- Wallet has sufficient SOL for fees
- RPC endpoint is working
- Transaction size is within limits
- Slippage tolerance is reasonable

---

## Support

For issues or questions:
1. Check console logs for detailed error messages
2. Review Jupiter API documentation: https://dev.jup.ag/
3. Check Solana RPC status
4. Verify wallet balance and permissions

---

## Security Notes

⚠️ **Development Only**: This implementation uses a hot wallet stored in environment variables. This is suitable for development but NOT for production.

**Production Recommendations:**
- Use hardware wallet integration
- Implement user wallet connection (Phantom/Solflare)
- Add transaction signing confirmation
- Implement multi-signature for large trades
- Add audit logging for all trades

