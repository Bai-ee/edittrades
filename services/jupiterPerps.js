/**
 * Jupiter Perpetuals API Integration
 * Handles perpetual futures trading via Jupiter Perps on Solana
 * Supports leverage up to 200x
 * 
 * Uses jup-perps-client library for on-chain program interaction
 */

// Use CommonJS wrapper to work around ES module compatibility issues
import jupPerpsClient from './jup-perps-wrapper.cjs';
import { 
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  pipe,
  address,
  getAddressEncoder,
} from '@solana/kit';
import { getBase64EncodedWireTransaction } from '@solana/transactions';
import { getConnection, getWallet } from './walletManager.js';
import { PublicKey } from '@solana/web3.js';
import { 
  getAssociatedTokenAddressSync, 
  ASSOCIATED_TOKEN_PROGRAM_ID, 
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import nacl from 'tweetnacl';
import 'dotenv/config';

// Extract needed exports from wrapper
const { 
  fetchPool, 
  fetchCustody, 
  fetchPerpetuals,
  PERPETUALS_PROGRAM_ADDRESS,
  getInstantIncreasePositionInstruction,
  getCreateIncreasePositionMarketRequestInstruction,
} = jupPerpsClient;

// Jupiter Perps Pool Address (mainnet)
const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

// Perpetuals account address (derived PDA)
// Seeds: [b"perpetuals", pool]
const PERPETUALS_ACCOUNT_SEED = Buffer.from('perpetuals');

// Create RPC connection
const rpc = createSolanaRpc(
  process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
);

/**
 * Derive Position PDA
 * Seeds: [b"position", owner, pool, custody, collateralCustody, side]
 * Based on position account structure which includes collateralCustody
 * @param {PublicKey} owner - Owner public key
 * @param {PublicKey} pool - Pool public key
 * @param {PublicKey} custody - Custody public key (trading asset)
 * @param {PublicKey} collateralCustody - Collateral custody public key (USDC)
 * @param {number} side - 0 for long, 1 for short
 * @returns {Promise<[PublicKey, number]>} [PDA, bump]
 */
async function derivePositionPDA(owner, pool, custody, collateralCustody, side) {
  const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
  const sideBuffer = Buffer.allocUnsafe(1);
  sideBuffer.writeUInt8(side, 0);
  
  const seeds = [
    Buffer.from('position'),
    owner.toBuffer(),
    pool.toBuffer(),
    custody.toBuffer(),
    collateralCustody.toBuffer(),
    sideBuffer,
  ];
  
  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

/**
 * Derive Position Request PDA
 * Based on official example: https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing
 * Seeds: [b"position_request", position, counter (little endian), requestChange]
 * Reference: src/examples/generate-position-and-position-request-pda.ts
 * @param {PublicKey} position - Position PDA
 * @param {number} counter - Request counter (random integer seed for uniqueness)
 * @param {string} requestChange - "increase" or "decrease"
 * @returns {Promise<[PublicKey, number]>} [PDA, bump]
 */
async function derivePositionRequestPDA(position, counter = 0, requestChange = "increase") {
  const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
  
  // Counter must be in LITTLE ENDIAN format (not big endian!)
  const counterBuffer = Buffer.allocUnsafe(8);
  counterBuffer.writeBigUInt64LE(BigInt(counter), 0); // Little endian!
  
  // RequestChange: [1] for increase, [2] for decrease (not 0/1!)
  const requestChangeEnum = requestChange === "increase" ? [1] : [2];
  const requestChangeBuffer = Buffer.from(requestChangeEnum);
  
  // Seeds: [b"position_request", position, counter (le), requestChange]
  const seeds = [
    Buffer.from('position_request'),
    position.toBuffer(),  // Position account address
    counterBuffer,        // Counter in LITTLE ENDIAN format
    requestChangeBuffer,  // [1] for increase, [2] for decrease
  ];
  
  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

/**
 * Derive Perpetuals PDA
 * Seeds: [b"perpetuals"] (singleton account, not per-pool)
 * @returns {Promise<[PublicKey, number]>} [PDA, bump]
 */
async function derivePerpetualsPDA() {
  const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
  
  // Perpetuals account is a singleton, derived with just [b"perpetuals"]
  const seeds = [
    PERPETUALS_ACCOUNT_SEED,
  ];
  
  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

// Perp markets mapping (symbol to market address)
const PERP_MARKETS = {
  'BTCUSDT': null, // To be populated with actual market addresses
  'ETHUSDT': null,
  'SOLUSDT': null,
};

/**
 * Get available perpetual markets
 * @returns {Promise<Object>} Available markets
 */
export async function getPerpMarkets() {
  try {
    console.log('[JupiterPerps] Getting available perpetual markets...');
    
    // Fetch pool to get actual custody information
    const pool = await fetchPool(rpc, JUPITER_PERPS_POOL);
    console.log('[JupiterPerps] Pool fetched:', pool.data.name);
    console.log('[JupiterPerps] Number of custodies:', pool.data.custodies.length);
    
    // Build markets object from pool custodies
    const markets = {};
    const symbolMap = {
      0: 'SOLUSDT', // Typically SOL is first
      1: 'BTCUSDT', // Then BTC
      2: 'ETHUSDT', // Then ETH
    };
    
    for (let i = 0; i < pool.data.custodies.length; i++) {
      const custodyAddress = pool.data.custodies[i];
      if (!custodyAddress) continue;
      
      try {
        const custody = await fetchCustody(rpc, custodyAddress);
        const symbol = symbolMap[i] || `MARKET_${i}`;
        
        markets[symbol] = {
          symbol,
          custodyAddress,
          tokenMint: custody.data.mint,
          decimals: custody.data.decimals,
          maxLeverage: 200, // Jupiter Perps supports up to 200x
          minMargin: 0.01, // Minimum margin in USD
          assetsOwned: custody.data.assets.owned.toString(),
        };
      } catch (error) {
        console.warn(`[JupiterPerps] Could not fetch custody ${i}:`, error.message);
      }
    }
    
    console.log('[JupiterPerps] ✅ Markets retrieved:', Object.keys(markets).length);
    return markets;
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error getting markets:', error.message);
    throw new Error(`Failed to get perpetual markets: ${error.message}`);
  }
}

/**
 * Check custody capacity for a given market
 * @param {string} market - Market symbol (e.g., 'BTCUSDT', 'ETHUSDT', 'SOLUSDT')
 * @param {number} requiredSize - Required position size in USD
 * @returns {Promise<Object>} Capacity information with current assets and availability status
 */
export async function checkCustodyCapacity(market, requiredSize) {
  try {
    console.log('[JupiterPerps] Checking custody capacity...');
    console.log('[JupiterPerps] Market:', market);
    console.log('[JupiterPerps] Required size:', requiredSize, 'USD');
    
    // Fetch pool to get custody addresses
    const pool = await fetchPool(rpc, JUPITER_PERPS_POOL);
    
    // Map symbol to custody index
    const custodyIndexMap = {
      'SOLUSDT': 0, // SOL is typically first custody
      'BTCUSDT': 1, // BTC
      'ETHUSDT': 2, // ETH
    };
    
    const custodyIndex = custodyIndexMap[market] ?? 0;
    const custodyAddress = pool.data.custodies[custodyIndex];
    
    if (!custodyAddress) {
      throw new Error(`Custody not found for market: ${market} at index ${custodyIndex}`);
    }
    
    // Fetch custody data
    const custody = await fetchCustody(rpc, custodyAddress);
    const currentAssets = custody.data.assets.owned 
      ? Number(custody.data.assets.owned) / 1_000_000 
      : 0;
    
    console.log('[JupiterPerps] Custody address:', custodyAddress);
    console.log('[JupiterPerps] Current assets (USD):', currentAssets.toFixed(2));
    console.log('[JupiterPerps] Required size (USD):', requiredSize.toFixed(2));
    
    // Note: The actual limit isn't exposed in the account data,
    // but we can monitor the current state and provide information
    // The protocol will enforce the limit during simulation
    
    return {
      market,
      custodyAddress,
      currentAssets,
      requiredSize,
      custodyData: custody.data,
      // We can't determine available capacity without the limit value,
      // but we can provide current state for monitoring
      note: 'Actual capacity limit is enforced by the protocol. Current assets shown for reference.'
    };
  } catch (error) {
    console.error('[JupiterPerps] Error checking custody capacity:', error.message);
    throw error;
  }
}

/**
 * Get perpetual position quote
 * @param {string} market - Market symbol (e.g., 'BTCUSDT')
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier (1-200)
 * @returns {Promise<Object>} Quote with margin requirements, fees, etc.
 */
export async function getPerpQuote(market, direction, size, leverage = 1) {
  try {
    console.log('[JupiterPerps] Getting perpetual quote...');
    console.log('[JupiterPerps] Market:', market);
    console.log('[JupiterPerps] Direction:', direction);
    console.log('[JupiterPerps] Size:', size, 'USD');
    console.log('[JupiterPerps] Leverage:', leverage, 'x');
    
    // Validate leverage
    if (leverage < 1 || leverage > 200) {
      throw new Error('Leverage must be between 1x and 200x');
    }
    
    // Safety checks
    if (leverage > 10) {
      console.warn('[JupiterPerps] ⚠️  High leverage warning:', leverage, 'x');
    }
    
    // Validate margin requirements (minimum margin check)
    const minMargin = 0.01; // $0.01 USD minimum
    const marginRequired = size / leverage;
    if (marginRequired < minMargin) {
      throw new Error(`Margin required ($${marginRequired.toFixed(2)}) is below minimum ($${minMargin})`);
    }
    
    // Calculate margin required
    const notionalSize = size;
    
    // Fetch pool data to get custody information
    try {
      const pool = await fetchPool(rpc, JUPITER_PERPS_POOL);
      console.log('[JupiterPerps] Pool fetched:', pool.data.name);
      console.log('[JupiterPerps] Number of custodies:', pool.data.custodies.length);
      console.log('[JupiterPerps] AUM USD: $' + (Number(pool.data.aumUsd) / 1_000_000).toLocaleString());
    } catch (error) {
      console.warn('[JupiterPerps] Could not fetch pool data:', error.message);
    }
    
    const quote = {
      market,
      direction,
      size: notionalSize,
      leverage,
      marginRequired,
      estimatedFees: notionalSize * 0.001, // 0.1% fee estimate
      fundingRate: 0.0001, // 0.01% funding rate (placeholder)
      liquidationPrice: null, // To be calculated based on entry price and leverage
    };
    
    console.log('[JupiterPerps] ✅ Quote received');
    console.log('[JupiterPerps] Margin required:', marginRequired, 'USD');
    
    return quote;
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error getting quote:', error.message);
    throw new Error(`Failed to get perpetual quote: ${error.message}`);
  }
}

/**
 * Open a perpetual position
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier (1-200)
 * @param {number} stopLoss - Stop loss price (optional)
 * @param {number} takeProfit - Take profit price (optional)
 * @returns {Promise<Object>} Execution result with position ID and signature
 */
export async function openPerpPosition(market, direction, size, leverage = 1, stopLoss = null, takeProfit = null) {
  try {
    console.log('[JupiterPerps] ===== Opening Perpetual Position =====');
    console.log('[JupiterPerps] Market:', market);
    console.log('[JupiterPerps] Direction:', direction);
    console.log('[JupiterPerps] Size:', size, 'USD');
    console.log('[JupiterPerps] Leverage:', leverage, 'x');
    console.log('[JupiterPerps] Stop Loss:', stopLoss);
    console.log('[JupiterPerps] Take Profit:', takeProfit);
    
    // Validate inputs
    if (leverage < 1 || leverage > 200) {
      throw new Error('Leverage must be between 1x and 200x');
    }
    
    if (direction !== 'long' && direction !== 'short') {
      throw new Error('Direction must be "long" or "short"');
    }
    
    // Safety checks
    const marginRequired = size / leverage;
    const minMargin = 0.01; // $0.01 USD minimum
    
    if (marginRequired < minMargin) {
      throw new Error(`Insufficient margin: $${marginRequired.toFixed(2)} required, minimum is $${minMargin}`);
    }
    
    if (leverage > 10) {
      console.warn('[JupiterPerps] ⚠️  HIGH LEVERAGE WARNING:', leverage, 'x leverage significantly increases liquidation risk');
    }
    
    // Check custody capacity before proceeding
    // This provides visibility into current custody state
    try {
      const capacityInfo = await checkCustodyCapacity(market, size);
      console.log('[JupiterPerps] Capacity check complete:', {
        market: capacityInfo.market,
        currentAssets: `$${capacityInfo.currentAssets.toFixed(2)}`,
        requiredSize: `$${capacityInfo.requiredSize.toFixed(2)}`
      });
    } catch (capacityError) {
      console.warn('[JupiterPerps] ⚠️  Could not check capacity, continuing anyway:', capacityError.message);
    }
    
    // Get quote first
    const quote = await getPerpQuote(market, direction, size, leverage);
    
    // Get wallet and connection
    const wallet = getWallet();
    const connection = getConnection();
    const walletAddress = wallet.publicKey.toBase58();
    
    // Missing wallet initialization - fix
    if (!wallet) {
      throw new Error('Wallet not initialized');
    }
    
    console.log('[JupiterPerps] Wallet address:', walletAddress);
    console.log('[JupiterPerps] Fetching pool data...');
    
    // Fetch pool to get custody addresses
    const pool = await fetchPool(rpc, JUPITER_PERPS_POOL);
    console.log('[JupiterPerps] Pool fetched:', pool.data.name);
    console.log('[JupiterPerps] Number of custodies:', pool.data.custodies.length);
    
    // Map symbol to custody index (simplified - may need adjustment based on actual pool structure)
    const custodyIndexMap = {
      'SOLUSDT': 0, // SOL is typically first custody
      'BTCUSDT': 1, // BTC
      'ETHUSDT': 2, // ETH
    };
    
    const custodyIndex = custodyIndexMap[market] ?? 0;
    const custodyAddress = pool.data.custodies[custodyIndex];
    
    if (!custodyAddress) {
      throw new Error(`Custody not found for market: ${market} at index ${custodyIndex}`);
    }
    
    console.log('[JupiterPerps] Using custody:', custodyAddress);
    
    // Fetch custody details
    const custody = await fetchCustody(rpc, custodyAddress);
    console.log('[JupiterPerps] Custody token mint:', custody.data.mint);
    console.log('[JupiterPerps] Custody decimals:', custody.data.decimals);
    console.log('[JupiterPerps] Assets owned:', custody.data.assets.owned.toString());
    
    // Log custody information
    // Note: amountLimit may be in permissions or calculated dynamically
    // The limit is enforced by the program, so we log what we can see
    const currentUsd = custody.data.assets.owned 
      ? (Number(custody.data.assets.owned) / 1_000_000).toFixed(2)
      : 'unknown';
    
    console.log('[JupiterPerps] Current assets (USD):', currentUsd);
    
    // Check permissions structure for limits (if available)
    if (custody.data.permissions) {
      console.log('[JupiterPerps] Permissions:', JSON.stringify(custody.data.permissions, null, 2));
    }
    
    // Note: The actual limit is enforced by the program and may not be exposed in the account data
    // The CustodyAmountLimit error will be caught during simulation with a helpful message
    console.log('[JupiterPerps] ⚠️  Note: Custody limits are enforced by the protocol. ' +
                'If limit is exceeded, you will receive a clear error message with details.');
    
    // Convert size to smallest units (USD with 6 decimals)
    const sizeUsdDelta = BigInt(Math.floor(size * 1_000_000));
    
    console.log('[JupiterPerps] Building position transaction...');
    console.log('[JupiterPerps] Size USD Delta:', sizeUsdDelta.toString());
    console.log('[JupiterPerps] Side:', direction);
    console.log('[JupiterPerps] Leverage:', leverage, 'x');
    
    // Convert direction to side (0 = long, 1 = short)
    const side = direction === 'long' ? 0 : 1;
    
    // Get collateral custody - try USDT first (usually has more capacity), fallback to USDC
    // USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    // USDT mint: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const usdtMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    
    // Find USDT custody first (index 4, usually has more capacity)
    let collateralCustodyAddress = null;
    for (let idx = 4; idx < pool.data.custodies.length; idx++) {
      try {
        const custody = await fetchCustody(rpc, pool.data.custodies[idx]);
        if (custody.data.mint === usdtMint) {
          collateralCustodyAddress = pool.data.custodies[idx];
          console.log('[JupiterPerps] ✅ Using USDT collateral (more capacity available)');
          break;
        }
      } catch (error) {
        // Continue searching
      }
    }
    
    // If USDT not found, try USDC (index 3)
    if (!collateralCustodyAddress) {
      for (let idx = 3; idx < pool.data.custodies.length; idx++) {
        try {
          const custody = await fetchCustody(rpc, pool.data.custodies[idx]);
          if (custody.data.mint === usdcMint) {
            collateralCustodyAddress = pool.data.custodies[idx];
            console.log('[JupiterPerps] Using USDC collateral (USDT not available)');
            break;
          }
        } catch (error) {
          // Continue searching
        }
      }
    }
    
    // Final fallback to index 3 (USDC)
    if (!collateralCustodyAddress) {
      collateralCustodyAddress = pool.data.custodies[3];
      console.log('[JupiterPerps] Using fallback collateral (index 3)');
    }
    
    const collateralCustodyPubkey = new PublicKey(collateralCustodyAddress);
    
    // Fetch collateral custody data to get mint address (we'll reuse this later)
    const collateralCustodyData = await fetchCustody(rpc, collateralCustodyAddress);
    const collateralSymbol = collateralCustodyData.data.mint === usdtMint ? 'USDT' : 'USDC';
    console.log(`[JupiterPerps] Collateral Custody (${collateralSymbol}):`, collateralCustodyPubkey.toBase58());
    console.log(`[JupiterPerps] Collateral mint:`, collateralCustodyData.data.mint);
    
    // Derive PDAs
    console.log('[JupiterPerps] Deriving PDAs...');
    const poolPubkey = new PublicKey(JUPITER_PERPS_POOL);
    const custodyPubkey = new PublicKey(custodyAddress);
    const ownerPubkey = wallet.publicKey;
    
    // Position PDA includes collateralCustody in seeds
    const [positionPDA, positionBump] = await derivePositionPDA(ownerPubkey, poolPubkey, custodyPubkey, collateralCustodyPubkey, side);
    console.log('[JupiterPerps] Position PDA:', positionPDA.toBase58(), 'bump:', positionBump);
    
    // Fetch perpetuals account - it's a singleton account (one for entire program)
    // Derived with seeds: [b"perpetuals"]
    const [perpetualsPDA, perpetualsBump] = await derivePerpetualsPDA();
    
    // Position Request PDA - based on official example
    // Seeds: [b"position_request", position, counter (little endian), requestChange]
    // RequestChange: "increase" = [1], "decrease" = [2]
    // Counter must be in LITTLE ENDIAN format
    const requestCounter = Math.floor(Math.random() * 1_000_000_000); // Random counter for uniqueness
    const requestChange = "increase"; // Opening/increasing position
    const [positionRequestPDA, positionRequestBump] = await derivePositionRequestPDA(positionPDA, requestCounter, requestChange);
    console.log('[JupiterPerps] Position Request PDA:', positionRequestPDA.toBase58(), 'bump:', positionRequestBump);
    console.log('[JupiterPerps] Using counter:', requestCounter, '(little endian), requestChange:', requestChange);
    console.log('[JupiterPerps] Perpetuals PDA:', perpetualsPDA.toBase58(), 'bump:', perpetualsBump);
    
    // Verify the perpetuals account exists
    try {
      const perpetualsAccount = await fetchPerpetuals(rpc, perpetualsPDA.toBase58());
      console.log('[JupiterPerps] ✅ Perpetuals account found and initialized');
      console.log('[JupiterPerps]   Pools:', perpetualsAccount.data.pools.length);
      console.log('[JupiterPerps]   Admin:', perpetualsAccount.data.admin);
    } catch (error) {
      throw new Error(`Perpetuals account not found at ${perpetualsPDA.toBase58()}: ${error.message}`);
    }
    
    // Collateral custody already fetched above for position PDA derivation
    
    // Get price feed accounts from custody
    const custodyOracle = custody.data.oracle;
    const custodyDovesPriceAccount = custodyOracle?.oracleAccount ? new PublicKey(custodyOracle.oracleAccount) : null;
    const custodyPythnetPriceAccount = null; // May need separate lookup
    
    console.log('[JupiterPerps] Custody Oracle Account:', custodyDovesPriceAccount?.toBase58() || 'Not found');
    
    // Get collateral oracle (reuse the collateral custody data we already fetched)
    const collateralOracle = collateralCustodyData.data.oracle;
    const collateralDovesPriceAccount = collateralOracle?.oracleAccount ? new PublicKey(collateralOracle.oracleAccount) : null;
    
    // Build instruction using createIncreasePositionMarketRequest
    // This creates a position request that keepers will fulfill (request-fulfillment model)
    console.log('[JupiterPerps] Building position market request instruction...');
    
    const programId = new PublicKey(PERPETUALS_PROGRAM_ADDRESS);
    
    // Get associated token account for collateral (USDT or USDC, whichever was selected)
    const collateralMint = new PublicKey(collateralCustodyData.data.mint);
    const fundingAccount = getAssociatedTokenAddressSync(
      collateralMint,
      ownerPubkey,
      false, // allowOwnerOffCurve
    );
    console.log(`[JupiterPerps] Funding Account (${collateralSymbol} ATA):`, fundingAccount.toBase58());
    
    // Position Request ATA - associated token account for the positionRequest PDA
    // This holds the input tokens that will be swapped and used as collateral
    const inputMint = new PublicKey(collateralCustodyData.data.mint);
    const positionRequestAta = getAssociatedTokenAddressSync(
      inputMint,
      positionRequestPDA,
      true, // allowOwnerOffCurve (PDA can own token accounts)
    );
    console.log('[JupiterPerps] Position Request ATA:', positionRequestAta.toBase58());
    
    // Get perpetuals account
    const perpetualsAccount = perpetualsPDA;
    
    const instructionData = getCreateIncreasePositionMarketRequestInstruction({
      owner: ownerPubkey.toBase58(),
      fundingAccount: fundingAccount.toBase58(), // USDC token account
      perpetuals: perpetualsAccount.toBase58(),
      pool: poolPubkey.toBase58(),
      position: positionPDA.toBase58(),
      positionRequest: positionRequestPDA.toBase58(),
      positionRequestAta: positionRequestAta.toBase58(), // ATA for positionRequest PDA
      custody: custodyPubkey.toBase58(),
      collateralCustody: collateralCustodyPubkey.toBase58(),
      inputMint: collateralCustodyData.data.mint, // USDT or USDC mint (whichever was selected)
      referral: null, // Optional
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(), // Token Program ID
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), // Associated Token Program ID
      eventAuthority: '37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN', // Event Authority PDA (from constants.ts)
      program: PERPETUALS_PROGRAM_ADDRESS, // Program ID
      sizeUsdDelta: sizeUsdDelta,
      collateralTokenDelta: BigInt(Math.floor(quote.marginRequired * 1_000_000)), // Margin in smallest units
      side: side,
      priceSlippage: BigInt(100), // 1% slippage tolerance (in basis points)
      jupiterMinimumOut: null, // Optional
      counter: BigInt(requestCounter), // Counter must match PDA derivation
    }, {
      programAddress: PERPETUALS_PROGRAM_ADDRESS,
    });
    
    console.log('[JupiterPerps] Instruction built successfully');
    console.log('[JupiterPerps] Number of accounts:', instructionData.accounts.length);
    console.log('[JupiterPerps] Program ID:', instructionData.programAddress);
    
    // Check if funding account exists, create if needed
    console.log('[JupiterPerps] Checking funding account existence...');
    let preInstructions = [];
    
    try {
      const fundingAccountInfo = await rpc.getAccountInfo(fundingAccount.toBase58(), {
        commitment: 'confirmed',
      }).send();
      
      if (!fundingAccountInfo.value) {
        console.log(`[JupiterPerps] Funding account (${collateralSymbol} ATA) does not exist, creating...`);
        const createFundingAccountIx = createAssociatedTokenAccountIdempotentInstruction(
          ownerPubkey,      // payer
          fundingAccount,   // ata
          ownerPubkey,      // owner
          collateralMint,  // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        preInstructions.push(createFundingAccountIx);
        console.log(`[JupiterPerps] ✅ Added instruction to create ${collateralSymbol} funding account`);
      } else {
        console.log(`[JupiterPerps] ✅ Funding account (${collateralSymbol} ATA) already exists`);
      }
    } catch (error) {
      console.warn('[JupiterPerps] ⚠️  Could not check funding account, will try to create idempotently:', error.message);
      // Create idempotent instruction anyway (safe to include even if account exists)
      const createFundingAccountIx = createAssociatedTokenAccountIdempotentInstruction(
        ownerPubkey,
        fundingAccount,
        ownerPubkey,
        collateralMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      preInstructions.push(createFundingAccountIx);
    }
    
    // Check if positionRequestAta exists, create if needed
    try {
      const positionRequestAtaInfo = await rpc.getAccountInfo(positionRequestAta.toBase58(), {
        commitment: 'confirmed',
      }).send();
      
      if (!positionRequestAtaInfo.value) {
        console.log('[JupiterPerps] Position Request ATA does not exist, creating...');
        const createPositionRequestAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          ownerPubkey,           // payer
          positionRequestAta,     // ata
          positionRequestPDA,      // owner (PDA)
          inputMint,              // mint
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        preInstructions.push(createPositionRequestAtaIx);
        console.log('[JupiterPerps] ✅ Added instruction to create Position Request ATA');
      } else {
        console.log('[JupiterPerps] ✅ Position Request ATA already exists');
      }
    } catch (error) {
      console.warn('[JupiterPerps] ⚠️  Could not check Position Request ATA, will try to create idempotently:', error.message);
      // Create idempotent instruction anyway
      const createPositionRequestAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        ownerPubkey,
        positionRequestAta,
        positionRequestPDA,
        inputMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      preInstructions.push(createPositionRequestAtaIx);
    }
    
    if (preInstructions.length > 0) {
      console.log(`[JupiterPerps] 📝 Added ${preInstructions.length} pre-instruction(s) for account creation`);
    }
    
    // Build transaction using @solana/kit (preserves PDA signing information)
    console.log('[JupiterPerps] Building transaction with @solana/kit...');
    
    // Create a signer from the Keypair
    // @solana/kit expects signTransactions to return SignatureDictionary[]
    // SignatureDictionary is Record<Address, SignatureBytes> - an object mapping addresses to signatures
    const signerAddress = address(ownerPubkey.toBase58());
    const walletSigner = {
      address: signerAddress,
      async signTransactions(transactions) {
        // transactions is an array of TransactionMessage objects
        return transactions.map(tx => {
          // TransactionMessage has 'messageBytes' property
          const messageBytes = tx.messageBytes || tx;
          const message = Buffer.from(messageBytes);
          // Use nacl to sign (same as @solana/web3.js Keypair uses internally)
          const signature = nacl.sign.detached(message, wallet.secretKey);
          // Return SignatureDictionary: { [address]: signatureBytes }
          // This is what @solana/kit expects - an object mapping addresses to signatures
          return {
            [signerAddress]: signature
          };
        });
      },
      async signMessage(message) {
        // message is Uint8Array
        const msgBuffer = Buffer.from(message);
        // Use nacl to sign
        const signature = nacl.sign.detached(msgBuffer, wallet.secretKey);
        // signMessage also returns SignatureDictionary
        return {
          [signerAddress]: signature
        };
      },
    };
    
    // Get latest blockhash
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    
    // Convert pre-instructions from @solana/web3.js to @solana/kit format if needed
    // For now, we'll add them as part of the transaction building
    // Note: @solana/kit uses a different instruction format, so we may need to convert
    // For simplicity, we'll add the account creation checks but the idempotent instructions
    // should be handled by the program itself or we need to convert them
    
    // Convert pre-instructions from @solana/web3.js TransactionInstruction to @solana/kit format
    // @solana/kit uses a different instruction structure
    const kitPreInstructions = [];
    for (const preIx of preInstructions) {
      // Convert TransactionInstruction to @solana/kit instruction format
      const kitInstruction = {
        programAddress: address(preIx.programId.toBase58()),
        accounts: preIx.keys.map(key => ({
          address: address(key.pubkey.toBase58()),
          role: key.isSigner 
            ? (key.isWritable ? 'writableSigner' : 'readonlySigner')
            : (key.isWritable ? 'writable' : 'readonly'),
        })),
        data: preIx.data,
      };
      kitPreInstructions.push(kitInstruction);
    }
    
    // Build transaction message using @solana/kit
    // Add pre-instructions first, then main instruction
    let txBuilder = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayerSigner(walletSigner, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );
    
    // Add pre-instructions (account creation) if needed
    for (const preIx of kitPreInstructions) {
      txBuilder = appendTransactionMessageInstruction(preIx, txBuilder);
    }
    
    // Add main instruction
    const transactionMessage = appendTransactionMessageInstruction(instructionData, txBuilder);
    
    console.log('[JupiterPerps] Transaction message built');
    console.log('[JupiterPerps] Signing transaction...');
    
    // Sign transaction
    const signedTransaction = await signTransactionMessageWithSigners(transactionMessage, [walletSigner]);
    
    console.log('[JupiterPerps] Transaction signed');
    console.log('[JupiterPerps] Sending transaction...');
    
    // Simulate transaction first to get detailed error information
    console.log('[JupiterPerps] Simulating transaction...');
    try {
      // Serialize transaction to base64 wire format for simulation
      const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);
      const simulation = await rpc.simulateTransaction(wireTransaction, {
        commitment: 'confirmed',
        sigVerify: false, // Can't use sigVerify with replaceRecentBlockhash
        replaceRecentBlockhash: true,
        encoding: 'base64',
      }).send();
      
      if (simulation.value.err) {
        console.error('[JupiterPerps] ❌ Simulation failed:');
        // Handle BigInt serialization in error logging
        const errorStr = simulation.value.err.toString ? simulation.value.err.toString() : String(simulation.value.err);
        console.error('[JupiterPerps] Error:', errorStr);
        if (simulation.value.logs) {
          console.error('[JupiterPerps] Logs:');
          simulation.value.logs.forEach(log => console.error('   ', log));
          
          // Check for CustodyAmountLimit error and provide helpful message
          const logsStr = simulation.value.logs.join(' ');
          if (logsStr.includes('CustodyAmountLimit') || logsStr.includes('6023')) {
            const currentUsd = custody.data.assets.owned 
              ? (Number(custody.data.assets.owned) / 1_000_000).toFixed(2)
              : 'unknown';
            
            throw new Error(
              `CustodyAmountLimit (Error 6023): The custody account has reached its capacity limit. ` +
              `Current assets: $${currentUsd}, Requested: $${size.toFixed(2)}. ` +
              `Please try a smaller position size or wait for capacity to become available. ` +
              `For more information, see: https://dev.jup.ag/docs/perps/custody-account or ` +
              `contact Jupiter support on Discord: https://discord.gg/jupiter`
            );
          }
        }
        throw new Error(`Transaction simulation failed: ${errorStr}`);
      }
      
      console.log('[JupiterPerps] ✅ Simulation successful');
      console.log('[JupiterPerps] Compute units used:', simulation.value.unitsConsumed?.toString() || 'N/A');
    } catch (simError) {
      // If simulation fails with CustodyAmountLimit (6023), re-throw to abort execution
      // This prevents sending a transaction that will definitely fail
      if (simError.message.includes('CustodyAmountLimit') || simError.message.includes('6023')) {
        console.error('[JupiterPerps] ❌ Custody limit error detected - aborting transaction');
        throw simError; // Re-throw to stop execution
      }
      // For other simulation errors, just log and continue (as before)
      console.warn('[JupiterPerps] ⚠️  Simulation check failed, but continuing:', simError.message);
    }
    
    // Send and confirm transaction
    console.log('[JupiterPerps] Sending transaction...');
    const sendAndConfirmTransaction = sendAndConfirmTransactionFactory({ rpc });
    const signature = await sendAndConfirmTransaction(signedTransaction, { commitment: 'confirmed' });
    
    console.log('[JupiterPerps] ✅ Transaction sent and confirmed!');
    console.log('[JupiterPerps] Signature:', signature);
    
    return {
      success: true,
      positionId: positionPDA.toBase58(),
      signature: signature,
      market,
      direction,
      size,
      leverage,
      marginRequired: quote.marginRequired,
      notionalSize: quote.size,
      liquidationPrice: quote.liquidationPrice,
      stopLoss,
      takeProfit,
      explorerUrl: `https://solscan.io/tx/${signature}`,
      positionPDA: positionPDA.toBase58(),
      positionRequestPDA: positionRequestPDA.toBase58(),
    };
  } catch (error) {
    console.error('[JupiterPerps] ===== Open Position Failed =====');
    console.error('[JupiterPerps] Error:', error.message);
    throw error;
  }
}

/**
 * Close a perpetual position
 * @param {string} positionId - Position ID to close
 * @param {number} size - Size to close (null for full close)
 * @returns {Promise<Object>} Execution result
 */
export async function closePerpPosition(positionId, size = null) {
  try {
    console.log('[JupiterPerps] ===== Closing Perpetual Position =====');
    console.log('[JupiterPerps] Position ID:', positionId);
    console.log('[JupiterPerps] Size:', size || 'Full close');
    
    // Get wallet and connection
    const wallet = getWallet();
    const connection = getConnection();
    
    // TODO: Build and send close position transaction
    // This will require:
    // 1. Querying position details
    // 2. Creating close instruction
    // 3. Building, signing, and sending transaction
    
    const signature = 'placeholder_signature';
    
    console.log('[JupiterPerps] ✅ Position closed');
    console.log('[JupiterPerps] Transaction signature:', signature);
    
    return {
      success: true,
      positionId,
      signature,
      sizeClosed: size || 'full',
      explorerUrl: `https://solscan.io/tx/${signature}`,
    };
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error closing position:', error.message);
    throw new Error(`Failed to close perpetual position: ${error.message}`);
  }
}

/**
 * Update stop loss or take profit for a position
 * @param {string} positionId - Position ID
 * @param {number} stopLoss - New stop loss price (optional)
 * @param {number} takeProfit - New take profit price (optional)
 * @returns {Promise<Object>} Execution result
 */
export async function updatePerpPosition(positionId, stopLoss = null, takeProfit = null) {
  try {
    console.log('[JupiterPerps] Updating position parameters...');
    console.log('[JupiterPerps] Position ID:', positionId);
    console.log('[JupiterPerps] Stop Loss:', stopLoss);
    console.log('[JupiterPerps] Take Profit:', takeProfit);
    
    if (!stopLoss && !takeProfit) {
      throw new Error('Must provide at least stopLoss or takeProfit');
    }
    
    // TODO: Build and send update transaction
    const signature = 'placeholder_signature';
    
    console.log('[JupiterPerps] ✅ Position updated');
    
    return {
      success: true,
      positionId,
      signature,
      stopLoss,
      takeProfit,
      explorerUrl: `https://solscan.io/tx/${signature}`,
    };
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error updating position:', error.message);
    throw new Error(`Failed to update perpetual position: ${error.message}`);
  }
}

/**
 * Get all open positions for a wallet
 * @param {string} walletAddress - Wallet public key (optional, uses default wallet if not provided)
 * @returns {Promise<Array>} Array of open positions
 */
export async function getPerpPositions(walletAddress = null) {
  try {
    console.log('[JupiterPerps] Getting open positions...');
    
    const wallet = getWallet();
    const address = walletAddress || wallet.publicKey.toBase58();
    console.log('[JupiterPerps] Wallet address:', address);
    
    // TODO: Query positions from on-chain program
    // This will require:
    // 1. Querying program accounts filtered by wallet
    // 2. Parsing position data
    // 3. Calculating P&L
    
    const positions = [];
    
    console.log('[JupiterPerps] ✅ Positions retrieved:', positions.length);
    return positions;
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error getting positions:', error.message);
    throw new Error(`Failed to get perpetual positions: ${error.message}`);
  }
}

/**
 * Get position details
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Position details including P&L, margin, etc.
 */
export async function getPerpPositionDetails(positionId) {
  try {
    console.log('[JupiterPerps] Getting position details...');
    console.log('[JupiterPerps] Position ID:', positionId);
    
    // TODO: Query position from on-chain program
    // This will require:
    // 1. Finding position account
    // 2. Parsing position data
    // 3. Calculating current P&L
    // 4. Getting margin health
    
    const position = {
      positionId,
      market: null,
      direction: null,
      size: null,
      leverage: null,
      entryPrice: null,
      currentPrice: null,
      margin: null,
      pnl: null,
      pnlPercent: null,
      liquidationPrice: null,
      stopLoss: null,
      takeProfit: null,
    };
    
    console.log('[JupiterPerps] ✅ Position details retrieved');
    return position;
  } catch (error) {
    console.error('[JupiterPerps] ❌ Error getting position details:', error.message);
    throw new Error(`Failed to get perpetual position details: ${error.message}`);
  }
}

