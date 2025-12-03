# Solana Wallet Setup Guide

**Purpose:** Generate a Solana wallet and configure it for Jupiter trading integration.

---

## Method 1: Using the Generate Wallet Script (Recommended)

This is the easiest method - no Solana CLI required.

### Step 1: Run the Script

```bash
node scripts/generate-wallet.js
```

### Step 2: Copy the Output

The script will output something like:

```
SOLANA_PRIVATE_KEY=DNPp5GKTnsPPtQUe8UNjPcj1gyjpnDbvFoTFzTRYWivC
```

### Step 3: Add to .env File

Create or edit your `.env` file in the project root:

```bash
# Copy the entire line from the script output
SOLANA_PRIVATE_KEY=DNPp5GKTnsPPtQUe8UNjPcj1gyjpnDbvFoTFzTRYWivC

# Add RPC URL (use public for testing, or QuickNode/Helius for production)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Optional: Jupiter API key for higher rate limits
JUPITER_API_KEY=

# Trading configuration
AUTO_EXECUTION_ENABLED=false
MAX_TRADE_SIZE_USD=1000
MAX_TRADES_PER_HOUR=10
```

### Step 4: Verify It Works

```bash
node -e "import('./services/walletManager.js').then(m => m.verifyWallet())"
```

You should see:
- ✅ Wallet loaded
- ✅ Wallet address
- ✅ Balance (will be 0 SOL for new wallet)

---

## Method 2: Using Solana CLI

If you have Solana CLI installed:

### Step 1: Generate Keypair

```bash
solana-keygen new --outfile ~/.config/solana/id.json
```

**Note:** When prompted for a passphrase, you can press Enter for no passphrase (development only).

### Step 2: Extract Private Key

The keypair file is in JSON format. Extract the first 32 bytes (seed) and encode to base58:

```bash
# Using Node.js
node -e "
import { readFileSync } from 'fs';
import bs58 from 'bs58';
const keypair = JSON.parse(readFileSync('$HOME/.config/solana/id.json'));
const seed = new Uint8Array(keypair.slice(0, 32));
console.log('SOLANA_PRIVATE_KEY=' + bs58.encode(seed));
"
```

Or manually:
1. Open `~/.config/solana/id.json`
2. Copy the first 32 numbers from the array
3. Convert to base58 (use online tool or the Node.js script above)

### Step 3: Get Public Key

```bash
solana address
```

This shows your wallet address (public key).

---

## Method 3: Using an Existing Wallet

If you already have a Solana wallet (Phantom, Solflare, etc.):

### Option A: Export from Phantom/Solflare

1. Open your wallet extension
2. Go to Settings → Export Private Key
3. **⚠️ WARNING:** This exposes your private key - only do this for a test wallet!
4. The exported key is usually in base58 format already
5. Copy it to `.env` as `SOLANA_PRIVATE_KEY`

### Option B: Use Wallet's Seed Phrase

If you have a seed phrase (12 or 24 words), you can derive the keypair:

```javascript
// This requires additional libraries - not recommended for quick setup
// Better to use Method 1 or 2
```

---

## Method 4: Manual Node.js Script

Create a file `generate-wallet-manual.js`:

```javascript
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const keypair = Keypair.generate();
const seed = keypair.secretKey.slice(0, 32);
const privateKeyBase58 = bs58.encode(seed);

console.log('SOLANA_PRIVATE_KEY=' + privateKeyBase58);
console.log('Public Key:', keypair.publicKey.toBase58());
```

Run: `node generate-wallet-manual.js`

---

## Verifying Your Setup

### Test 1: Check Wallet Loads

```bash
node -e "import('./services/walletManager.js').then(async (m) => { 
  const wallet = m.getWallet(); 
  console.log('✅ Wallet loaded:', m.getWalletAddress()); 
})"
```

### Test 2: Check Balance

```bash
node -e "import('./services/walletManager.js').then(async (m) => { 
  const balance = await m.getBalance(); 
  console.log('Balance:', balance, 'SOL'); 
})"
```

### Test 3: Full Integration Test

```bash
node test-jupiter-integration.js
```

This will test:
- ✅ Wallet loading
- ✅ Token mapping
- ✅ Jupiter API connection
- ✅ Quote retrieval

---

## Funding Your Wallet

### For Testing (Devnet - Free)

1. Switch to devnet:
   ```bash
   solana config set --url devnet
   ```

2. Airdrop SOL (free):
   ```bash
   solana airdrop 1 YOUR_WALLET_ADDRESS
   ```

3. Update `.env`:
   ```bash
   SOLANA_RPC_URL=https://api.devnet.solana.com
   ```

### For Production (Mainnet - Real Money)

1. **Get SOL:**
   - Buy SOL on an exchange (Coinbase, Binance, etc.)
   - Send to your wallet address (public key from script output)

2. **Recommended amounts:**
   - Testing: 0.1 - 0.5 SOL
   - Small trades: 1 - 5 SOL
   - Production: Based on your trading strategy

3. **Transaction fees:**
   - Each transaction costs ~0.000005 SOL
   - Keep extra SOL for fees

---

## Security Best Practices

### ⚠️ Development Only

The current setup uses a **hot wallet** (private key in `.env` file). This is:
- ✅ Fine for development and testing
- ❌ NOT recommended for production
- ❌ NOT for large amounts

### Production Recommendations

1. **Use Hardware Wallet:**
   - Ledger, Trezor, etc.
   - Private key never leaves device

2. **User Wallet Connection:**
   - Let users connect Phantom/Solflare
   - Sign transactions in browser
   - No server-side private keys

3. **Multi-Signature:**
   - Require multiple approvals for large trades
   - Distribute risk

4. **Environment Security:**
   - Use secrets management (AWS Secrets Manager, etc.)
   - Never commit `.env` to git
   - Rotate keys regularly

---

## Troubleshooting

### Error: "SOLANA_PRIVATE_KEY environment variable is not set"

**Solution:**
- Check `.env` file exists in project root
- Verify variable name is exactly `SOLANA_PRIVATE_KEY`
- Restart server after adding to `.env`

### Error: "Invalid private key length"

**Solution:**
- Private key should be base58 encoded, 32 bytes (44 characters when encoded)
- If using full keypair (64 bytes), extract first 32 bytes
- Re-generate wallet if unsure

### Error: "Failed to load wallet"

**Solution:**
- Check private key format (should be base58 string)
- Verify no extra spaces or quotes in `.env`
- Try regenerating wallet

### Error: "Insufficient funds"

**Solution:**
- Fund wallet with SOL
- Check balance: `node -e "import('./services/walletManager.js').then(m => m.getBalance())"`
- Ensure enough SOL for transaction fees

---

## Quick Reference

### Generate New Wallet
```bash
node scripts/generate-wallet.js
```

### Verify Wallet
```bash
node -e "import('./services/walletManager.js').then(m => m.verifyWallet())"
```

### Check Balance
```bash
node -e "import('./services/walletManager.js').then(async (m) => console.log(await m.getBalance(), 'SOL'))"
```

### Test Integration
```bash
node test-jupiter-integration.js
```

---

## Next Steps

After setting up your wallet:

1. ✅ Add `SOLANA_PRIVATE_KEY` to `.env`
2. ✅ Fund wallet with SOL (0.1-0.5 SOL for testing)
3. ✅ Run integration tests
4. ✅ Test with small trades first
5. ✅ Monitor transaction fees
6. ✅ Check Jupiter API rate limits

---

## Support

If you encounter issues:
1. Check console logs for detailed error messages
2. Verify wallet balance
3. Check RPC endpoint is accessible
4. Review `docs/JUPITER_TRADING_INTEGRATION.md` for more details

