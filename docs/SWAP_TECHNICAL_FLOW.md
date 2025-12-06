# Swap Technical Flow Documentation

**Last Updated:** 2025-12-03  
**Status:** Complete Technical Breakdown

---

## Overview

This document provides a complete technical breakdown of the spot swap execution flow from frontend user interaction to on-chain transaction confirmation. This serves as a reference for understanding the system architecture and for implementing future features like perpetuals trading.

---

## Complete Execution Flow

### 1. Frontend User Interaction

**Location:** `public/index.html`

**User Actions:**
1. User views a valid trade signal (BTC, ETH, or SOL)
2. User selects "Spot Swap" trade type
3. User enters trade amount (USD, min: $0.25, max: $1000)
4. User clicks "EXECUTE TRADE" button

**Frontend Code Flow:**
```javascript
handleTradeButtonClick(symbol)
  → executeTrade(symbol, signal)
    → Extract tradeType, amount from UI
    → Validate amount (0.25 - 1000 USD)
    → POST /api/execute-trade
```

**Request Body:**
```json
{
  "symbol": "BTCUSDT",
  "signal": {
    "valid": true,
    "direction": "long",
    "entryZone": { "min": 90000, "max": 91000 },
    "stopLoss": 88000,
    "targets": [93000, 95000],
    "symbol": "BTCUSDT"
  },
  "tradeType": "spot",
  "amount": 0.25
}
```

---

### 2. API Endpoint Processing

**Location:** `api/execute-trade.js`

**Processing Steps:**
1. **CORS Headers:** Set CORS headers for cross-origin requests
2. **Method Validation:** Ensure POST request
3. **Request Parsing:** Extract `symbol`, `signal`, `tradeType`, `amount` from body
4. **Signal Validation:** Call `tradeExecution.validateSignal(signal)`
5. **Safety Limits:** Check `amount <= MAX_TRADE_SIZE_USD` (default: 1000)
6. **Trade Execution:** Call `tradeExecution.executeTrade(signal, tradeType, amount)`

**Error Handling:**
- Missing signal → 400 Bad Request
- Invalid signal → 400 Bad Request with validation errors
- Trade size exceeded → 400 Bad Request
- Execution failure → 500 Internal Server Error
- Missing env vars → 503 Service Unavailable

---

### 3. Trade Execution Orchestration

**Location:** `services/tradeExecution.js`

**Function:** `executeTrade(signal, tradeType, amountUSD)`

**Processing Steps:**

#### 3.1 Signal Validation
- Verify `signal.valid === true`
- Verify `signal.direction` is "long" or "short"
- Verify `signal.entryZone` has `min` and `max`
- Verify `signal.stopLoss` exists
- Verify `signal.targets` array exists and is non-empty

#### 3.2 Symbol Resolution
- Extract symbol from `signal.symbol` or `signal.pair` (default: 'SOLUSDT')
- Extract base token: `symbol.replace('USDT', '')` → 'BTC', 'ETH', or 'SOL'

#### 3.3 Token Address Mapping
- Call `tokenMapping.getTokenAddress(symbol)` → Get base token mint address
- Call `tokenMapping.getTokenAddress('USDC')` → Get USDC mint address
- Validate both addresses exist

**Token Addresses:**
- SOL: `So11111111111111111111111111111111111111112`
- BTC: `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` (WBTC)
- ETH: `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` (WETH)
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

#### 3.4 Amount Calculation

**For Long Trades (Buying Token):**
- Input: USDC
- Output: Base Token (BTC/ETH/SOL)
- Amount: `amountUSD` in USDC smallest units
- Conversion: `amountUSD * 10^6` (USDC has 6 decimals)
- Example: $0.25 USD → 250,000 smallest units

**For Short/Sell Trades (Selling Token):**
- Input: Base Token
- Output: USDC
- Amount: Calculate token amount from USD amount
- Formula: `tokenAmount = (amountUSD / currentPrice) * 1.01` (1% buffer)
- Conversion: `tokenAmount * 10^decimals` (SOL=9, BTC/ETH=8)
- Example: $0.25 USD at $100/token → 0.002525 tokens → 252,500 smallest units (8 decimals)

#### 3.5 Swap Direction Determination

**Long Trade:**
- `inputMint` = USDC address
- `outputMint` = Base token address
- `amountInSmallestUnit` = USDC amount (6 decimals)

**Short/Sell Trade:**
- `inputMint` = Base token address
- `outputMint` = USDC address
- `amountInSmallestUnit` = Token amount (8 or 9 decimals)

#### 3.6 Jupiter Swap Execution
- Call `jupiterSwap.swapTokens(inputMint, outputMint, amountInSmallestUnit, slippageBps)`
- Slippage tolerance: 100 bps (1%)

**Return Structure:**
```json
{
  "success": true,
  "tradeType": "spot",
  "direction": "long",
  "symbol": "BTCUSDT",
  "signature": "transaction_signature",
  "inputAmount": "250000",
  "outputAmount": "7993",
  "priceImpact": "0",
  "explorerUrl": "https://solscan.io/tx/..."
}
```

---

### 4. Jupiter Swap API Integration

**Location:** `services/jupiterSwap.js`

**API Endpoints:**
- Quote API: `https://lite-api.jup.ag/swap/v1/quote`
- Swap API: `https://lite-api.jup.ag/swap/v1/swap`

#### 4.1 Get Swap Quote

**Function:** `getSwapQuote(inputMint, outputMint, amountIn, slippageBps)`

**Request:**
```
GET https://lite-api.jup.ag/swap/v1/quote
Params:
  - inputMint: Token mint address
  - outputMint: Token mint address
  - amount: Amount in smallest unit (string)
  - slippageBps: Slippage in basis points (string)
  - onlyDirectRoutes: "false"
  - asLegacyTransaction: "false"
```

**Response:**
```json
{
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "inAmount": "250000",
  "outAmount": "7993",
  "priceImpactPct": "0",
  "routePlan": { ... }
}
```

#### 4.2 Build Swap Transaction

**Function:** `buildSwapTransaction(quote, userPublicKey)`

**Request:**
```
POST https://lite-api.jup.ag/swap/v1/swap
Body:
  - quoteResponse: Quote object from step 4.1
  - userPublicKey: Wallet public key (base58)
  - wrapAndUnwrapSol: true
  - dynamicComputeUnitLimit: true
  - prioritizationFeeLamports: "auto"
```

**Response:**
```json
{
  "swapTransaction": "base64_encoded_transaction"
}
```

**Processing:**
1. Decode base64 transaction to Buffer
2. Deserialize to `VersionedTransaction` using `@solana/web3.js`
3. Return transaction object ready for signing

#### 4.3 Execute Swap Transaction

**Function:** `executeSwap(transaction)`

**Steps:**
1. **Get Wallet:** Call `walletManager.getWallet()` → Get Keypair
2. **Sign Transaction:** `transaction.sign([wallet])`
3. **Get Connection:** Call `walletManager.getConnection()` → Get Solana RPC connection
4. **Send Transaction:** `connection.sendTransaction(transaction, { skipPreflight: false, maxRetries: 3 })`
5. **Wait for Confirmation:** `connection.confirmTransaction(signature, 'confirmed')`
6. **Return Signature:** Transaction signature (base58 string)

**Transaction Lifecycle:**
- Pending → Processing → Confirmed
- Slot number assigned upon confirmation
- Error field populated if transaction fails

---

### 5. Wallet Management

**Location:** `services/walletManager.js`

**Functions:**

#### 5.1 `getWallet()`
- Load `SOLANA_PRIVATE_KEY` from environment
- Decode base58 private key to Uint8Array
- Validate key length (32 or 64 bytes)
- Create `Keypair.fromSeed(seed)`
- Cache wallet instance (singleton pattern)

#### 5.2 `getConnection()`
- Load `SOLANA_RPC_URL` from environment (default: mainnet-beta)
- Create `Connection(rpcUrl, 'confirmed')`
- Cache connection instance (singleton pattern)

#### 5.3 `getWalletAddress()`
- Get wallet public key
- Return base58 encoded address

---

### 6. Token Mapping

**Location:** `services/tokenMapping.js`

**Functions:**

#### 6.1 `getTokenAddress(symbol)`
- Normalize symbol to uppercase
- Lookup in `TOKEN_ADDRESSES` mapping
- Return Solana mint address or null

#### 6.2 `getTokenDecimals(symbol)`
- Normalize symbol to uppercase
- Lookup in `TOKEN_DECIMALS` mapping
- Return decimals (default: 9 for SOL)

**Token Decimals:**
- SOL: 9 decimals
- BTC: 8 decimals
- ETH: 8 decimals
- USDC: 6 decimals
- USDT: 6 decimals

#### 6.3 `toTokenAmount(amount, symbol)`
- Convert human-readable amount to smallest unit
- Formula: `Math.floor(amount * 10^decimals)`
- Example: $0.25 USDC → 250,000 (6 decimals)

#### 6.4 `fromTokenAmount(amount, symbol)`
- Convert smallest unit to human-readable
- Formula: `amount / 10^decimals`
- Example: 250,000 USDC → $0.25 (6 decimals)

---

### 7. Frontend Response Handling

**Location:** `public/index.html`

**Function:** `executeTrade(symbol, signal)`

**Response Processing:**
1. Parse JSON response from API
2. Check `response.ok` and `result.success`
3. Calculate human-readable amounts:
   - `inputAmountUSD = result.inputAmount / 10^6` (USDC decimals)
   - `outputAmountTokens = result.outputAmount / 10^decimals` (token decimals)
   - `entryPrice = inputAmountUSD / outputAmountTokens`
4. Update UI:
   - Show success message
   - Display trade details (direction, type, amounts, entry price)
   - Show transaction signature and explorer link
   - Enable "Track Trade" button
5. Auto-track trade: Call `trackExecutedTrade(symbol)` after 1.5s
6. Poll transaction status: Call `pollTradeStatus(symbol, signature)`

**Status Polling:**
- Poll `/api/trade-status/:signature` every 10 seconds
- Max 30 attempts (5 minutes total)
- Update UI when transaction confirmed
- Stop polling on confirmation or error

---

## Data Structures

### Signal Object
```typescript
{
  valid: boolean;
  direction: "long" | "short";
  symbol: string;
  entryZone: {
    min: number;
    max: number;
  };
  stopLoss: number;
  targets: number[];
  currentPrice?: number;
}
```

### Trade Execution Result
```typescript
{
  success: boolean;
  tradeType: "spot";
  direction: "long" | "short";
  symbol: string;
  signature: string;
  inputAmount: string | number;
  outputAmount: string | number;
  priceImpact: string | number | null;
  explorerUrl: string;
  signal?: {
    entryZone: { min: number; max: number };
    stopLoss: number;
    targets: number[];
  };
}
```

### Jupiter Quote Response
```typescript
{
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan?: object;
}
```

---

## Error Handling Flow

### Frontend Errors
1. **Validation Error:** Amount out of range → Show toast, return early
2. **API Error:** Network failure → Show error message, re-enable button
3. **Execution Error:** Trade failed → Display error details, allow retry

### Backend Errors
1. **Missing Signal:** Return 400 with error message
2. **Invalid Signal:** Return 400 with validation errors array
3. **Token Not Found:** Return 500 with "Token address not found"
4. **Jupiter API Error:** Return 500 with API error details
5. **Transaction Failed:** Return 500 with transaction error
6. **Missing Env Var:** Return 503 with configuration error

### Jupiter API Errors
1. **Network Error (ENOTFOUND):** "Cannot connect to Jupiter API"
2. **API Error (4xx/5xx):** Include status code and response data
3. **Invalid Response:** "Invalid quote/transaction response"

---

## Transaction Lifecycle

1. **Pending:** Transaction sent to network, awaiting confirmation
2. **Processing:** Transaction included in block, being processed
3. **Confirmed:** Transaction confirmed on-chain
4. **Finalized:** Transaction finalized (irreversible)

**Confirmation Levels:**
- `processed`: Transaction received by cluster
- `confirmed`: Transaction confirmed by supermajority
- `finalized`: Transaction finalized (default used: 'confirmed')

---

## Amount Conversion Examples

### Example 1: Long Trade - $0.25 USDC → ETH

**Input:**
- Amount: $0.25 USD
- Direction: long
- Symbol: ETHUSDT

**Processing:**
1. `amountUSD = 0.25`
2. `inputMint = USDC` (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
3. `outputMint = WETH` (7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs)
4. `amountInSmallestUnit = 0.25 * 10^6 = 250,000` (USDC has 6 decimals)

**Jupiter Swap:**
- Input: 250,000 USDC smallest units
- Output: ~7,993 WETH smallest units (8 decimals)
- Human-readable output: 7,993 / 10^8 = 0.00007993 ETH

**Entry Price Calculation:**
- `entryPrice = 250,000 / 10^6 / (7,993 / 10^8) = 0.25 / 0.00007993 ≈ $3,127.50`

### Example 2: Sell Trade - $0.50 worth of SOL

**Input:**
- Amount: $0.50 USD
- Direction: short (sell)
- Symbol: SOLUSDT
- Current Price: $141.21

**Processing:**
1. `amountUSD = 0.50`
2. `currentPrice = 141.21`
3. `tokenAmount = (0.50 / 141.21) * 1.01 = 0.003576 SOL` (with 1% buffer)
4. `amountInSmallestUnit = 0.003576 * 10^9 = 3,576,000` (SOL has 9 decimals)
5. `inputMint = SOL` (So11111111111111111111111111111111111111112)
6. `outputMint = USDC` (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)

**Jupiter Swap:**
- Input: 3,576,000 SOL lamports
- Output: ~500,000 USDC smallest units (6 decimals)
- Human-readable output: 500,000 / 10^6 = $0.50 USDC

---

## Slippage and Price Impact

### Slippage Tolerance
- **Default:** 100 basis points (1%)
- **Configurable:** Can be adjusted per trade
- **Purpose:** Acceptable price deviation from quoted price

### Price Impact
- **Calculation:** Provided by Jupiter API in quote response
- **Display:** Shown to user in trade status
- **Warning:** High price impact (>5%) may indicate low liquidity

---

## Security Considerations

### Hot Wallet (Development Only)
- Private key stored in environment variables
- **NOT suitable for production**
- Use only for testing with minimal funds

### Transaction Signing
- All transactions signed with wallet private key
- Private key never exposed to frontend
- Signing happens server-side only

### Amount Validation
- Minimum: $0.25 USD (prevents dust transactions)
- Maximum: $1,000 USD (configurable via env)
- Validation on both frontend and backend

---

## Logging and Debugging

### Log Prefixes
- `[Frontend]` - Frontend operations
- `[ExecuteTrade]` - API endpoint processing
- `[TradeExecution]` - Trade orchestration
- `[JupiterSwap]` - Jupiter API calls
- `[WalletManager]` - Wallet operations
- `[TokenMapping]` - Token address resolution

### Key Log Points
1. Trade execution start
2. Signal validation result
3. Token address resolution
4. Amount calculation details
5. Jupiter quote retrieval
6. Transaction building
7. Transaction signing
8. Transaction sending
9. Transaction confirmation
10. Final result

---

## Future Enhancements

This technical flow serves as the foundation for:
- Perpetuals trading integration
- Position tracking
- Stop loss/take profit automation
- Multi-wallet support
- Advanced order types

---

## Related Documentation

- `docs/JUPITER_TRADING_INTEGRATION.md` - High-level integration guide
- `docs/SWAP_TROUBLESHOOTING.md` - Common issues and solutions
- `docs/VERCEL_TRADING_ENV_SETUP.md` - Environment variable setup


