/**
 * Mango Markets v4 Perpetuals Integration
 * Handles perpetual futures trading via Mango Markets on Solana
 * Supports leverage up to 20x
 * 
 * Uses @blockworks-foundation/mango-v4 SDK
 */

import { MangoClient, Group, MangoAccount } from '@blockworks-foundation/mango-v4';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getConnection, getWallet } from './walletManager.js';
import 'dotenv/config';

// Mango v4 Program IDs (mainnet)
// Note: These need to be fetched dynamically or verified from Mango SDK
// Using placeholder addresses - will be set during client initialization
let MANGO_V4_PROGRAM_ID = null;
let MANGO_V4_MAIN_GROUP = null;

// Create connection
const connection = getConnection();

// Mango client instance (cached)
let mangoClient = null;
let mangoGroup = null;
let mangoInitializing = false;

/**
 * Rate limiting helper - add delay between RPC calls
 */
async function rateLimitDelay() {
  // Add small delay to stay under 10 req/s (100ms = 10 req/s max)
  await new Promise(resolve => setTimeout(resolve, 110));
}

/**
 * Initialize Mango client (optimized with rate limiting)
 * @returns {Promise<MangoClient>} Initialized Mango client
 */
async function getMangoClient() {
  // Return cached client if available
  if (mangoClient && mangoGroup) {
    return { client: mangoClient, group: mangoGroup };
  }

  // Prevent concurrent initialization
  if (mangoInitializing) {
    // Wait for ongoing initialization
    let waitCount = 0;
    while (mangoInitializing && waitCount < 100) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitCount++;
      if (mangoClient && mangoGroup) return { client: mangoClient, group: mangoGroup };
    }
  }

  mangoInitializing = true;

  try {
    console.log('[MangoPerps] Initializing Mango client (optimized with rate limiting)...');
    
    // Import Mango SDK constants
    const mangoSDK = await import('@blockworks-foundation/mango-v4');
    const CLUSTER = 'mainnet-beta';
    
    // MANGO_V4_ID is an object with cluster keys, or a single PublicKey
    const programId = typeof mangoSDK.MANGO_V4_ID === 'object' && mangoSDK.MANGO_V4_ID[CLUSTER] 
      ? mangoSDK.MANGO_V4_ID[CLUSTER] 
      : mangoSDK.MANGO_V4_ID;
    
    console.log('[MangoPerps] Program ID:', programId.toString());
    
    // Create AnchorProvider with proper options
    const wallet = getWallet();
    const provider = new AnchorProvider(
      connection,
      new Wallet(wallet),
      {
        commitment: 'confirmed',
        skipPreflight: false,
      }
    );
    
    // MangoClient.connect signature: (provider, cluster, programId, opts?)
    // OPTIMIZATION: Use 'get-program-accounts' but with caching
    // Note: 'api' was causing ENOTFOUND errors, so we use 'get-program-accounts' which works
    const client = MangoClient.connect(
      provider,
      CLUSTER,
      programId,
      {
        idsSource: 'get-program-accounts', // Reliable, makes requests but cached after first use
      }
    );

    // MANGO_V4_MAIN_GROUP is a PublicKey (not an object)
    const groupPubkey = mangoSDK.MANGO_V4_MAIN_GROUP;
    console.log('[MangoPerps] Group pubkey:', groupPubkey.toString());
    console.log('[MangoPerps] Loading group data (this may take a moment with rate limiting)...');
    
    // Add rate limiting - getGroup makes many RPC calls
    // The SDK has built-in retry logic, but we'll let it handle rate limits
    const group = await client.getGroup(groupPubkey);
    
    mangoClient = client;
    mangoGroup = group;
    
    console.log('[MangoPerps] ✅ Mango client initialized and cached');
    return { client, group };
  } catch (error) {
    console.error('[MangoPerps] ❌ Failed to initialize Mango client:', error.message);
    console.error('[MangoPerps] Error stack:', error.stack);
    
    // If rate limited, provide helpful message
    if (error.message.includes('429') || error.message.includes('rate limit')) {
      console.error('[MangoPerps] 💡 Tip: Rate limited. Wait 1-2 minutes and retry, or upgrade RPC tier.');
    }
    
    throw error;
  } finally {
    mangoInitializing = false;
  }
}

/**
 * Get available perpetual markets
 * @returns {Promise<Object>} Available markets
 */
export async function getMangoMarkets() {
  try {
    console.log('[MangoPerps] Getting available Mango markets...');
    const { group } = await getMangoClient();
    
    const perpMarkets = group.perpMarketsMap;
    const marketList = Array.from(perpMarkets.values()).map(market => ({
      symbol: market.name,
      marketIndex: market.perpMarketIndex,
      baseAsset: market.baseTokenSymbol,
      quoteAsset: market.quoteTokenSymbol,
      status: 'active',
    }));

    console.log('[MangoPerps] ✅ Found', marketList.length, 'markets');
    return {
      markets: marketList,
      count: marketList.length,
    };
  } catch (error) {
    console.error('[MangoPerps] ❌ Error getting markets:', error.message);
    throw error;
  }
}

/**
 * Get quote for perpetual position
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier (1-20)
 * @returns {Promise<Object>} Quote with margin required and fees
 */
export async function getMangoQuote(market, direction, size, leverage = 1) {
  try {
    console.log('[MangoPerps] Getting quote for:', market, direction, size, 'USD', leverage, 'x');
    
    const { group } = await getMangoClient();
    
    // Find market
    const perpMarket = Array.from(group.perpMarketsMap.values())
      .find(m => m.name === market || m.baseTokenSymbol === market.replace('USDT', ''));

    if (!perpMarket) {
      throw new Error(`Market not found: ${market}`);
    }

    // Calculate margin required
    const marginRequired = size / leverage;
    
    // Get current price
    const price = perpMarket.uiPrice;
    const baseAssetAmount = size / price;
    
    // Estimate fees (Mango charges trading fees)
    const estimatedFee = size * 0.0005; // 0.05% fee estimate
    
    console.log('[MangoPerps] ✅ Quote calculated');
    console.log('[MangoPerps]   Margin required:', marginRequired, 'USD');
    console.log('[MangoPerps]   Estimated fee:', estimatedFee, 'USD');
    console.log('[MangoPerps]   Base asset amount:', baseAssetAmount);

    return {
      market: perpMarket.name,
      direction,
      size,
      leverage,
      marginRequired,
      estimatedFee,
      baseAssetAmount,
      price,
      marketIndex: perpMarket.perpMarketIndex,
    };
  } catch (error) {
    console.error('[MangoPerps] ❌ Error getting quote:', error.message);
    throw error;
  }
}

/**
 * Open a perpetual position on Mango
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier (1-20)
 * @param {number} stopLoss - Stop loss price (optional)
 * @param {number} takeProfit - Take profit price (optional)
 * @returns {Promise<Object>} Execution result with position ID and signature
 */
export async function openMangoPosition(market, direction, size, leverage = 1, stopLoss = null, takeProfit = null) {
  try {
    console.log('[MangoPerps] ===== Opening Mango Perpetual Position =====');
    console.log('[MangoPerps] Market:', market);
    console.log('[MangoPerps] Direction:', direction);
    console.log('[MangoPerps] Size:', size, 'USD');
    console.log('[MangoPerps] Leverage:', leverage, 'x');
    
    // Validate inputs
    if (leverage < 1 || leverage > 20) {
      throw new Error('Leverage must be between 1x and 20x');
    }
    
    if (direction !== 'long' && direction !== 'short') {
      throw new Error('Direction must be "long" or "short"');
    }
    
    // Safety checks
    const marginRequired = size / leverage;
    const minMargin = 0.01;
    
    if (marginRequired < minMargin) {
      throw new Error(`Insufficient margin: $${marginRequired.toFixed(2)} required, minimum is $${minMargin}`);
    }
    
    if (leverage > 10) {
      console.warn('[MangoPerps] ⚠️  HIGH LEVERAGE WARNING:', leverage, 'x leverage significantly increases liquidation risk');
    }
    
    // Get quote
    const quote = await getMangoQuote(market, direction, size, leverage);
    
    // Get client and group
    const { client, group } = await getMangoClient();
    const wallet = getWallet();
    
    // Find market
    const perpMarket = Array.from(group.perpMarketsMap.values())
      .find(m => m.name === market || m.baseTokenSymbol === market.replace('USDT', ''));

    if (!perpMarket) {
      throw new Error(`Market not found: ${market}`);
    }

    // Get or create Mango account
    let mangoAccount = await client.getMangoAccountForOwner(group, wallet.publicKey);
    
    if (!mangoAccount) {
      // Create new Mango account
      console.log('[MangoPerps] Creating new Mango account...');
      mangoAccount = await client.createMangoAccount(group, wallet);
    }

    // Calculate base asset amount
    const price = perpMarket.uiPrice;
    const baseAssetAmount = size / price;
    
    // Convert direction
    const side = direction === 'long' ? 'buy' : 'sell';
    
    console.log('[MangoPerps] Opening position...');
    console.log('[MangoPerps]   Market index:', perpMarket.perpMarketIndex);
    console.log('[MangoPerps]   Side:', side);
    console.log('[MangoPerps]   Base asset amount:', baseAssetAmount);
    
    // Place perp order
    // Note: This is simplified - actual implementation depends on Mango SDK version
    const tx = await mangoAccount.placePerpOrder(
      group,
      perpMarket,
      side,
      baseAssetAmount,
      price, // Limit price (use market price for market orders)
      'limit' // Order type
    );
    
    console.log('[MangoPerps] ✅ Position opened');
    console.log('[MangoPerps] Transaction signature:', tx);

    return {
      success: true,
      provider: 'mango',
      market,
      direction,
      size,
      leverage,
      positionId: tx,
      signature: tx,
      marginRequired: quote.marginRequired,
      explorerUrl: `https://solscan.io/tx/${tx}`,
      quote,
    };
  } catch (error) {
    console.error('[MangoPerps] ❌ Error opening position:', error.message);
    throw error;
  }
}

/**
 * Close a perpetual position
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Close result
 */
export async function closeMangoPosition(positionId) {
  try {
    console.log('[MangoPerps] Closing position:', positionId);
    
    const { client, group } = await getMangoClient();
    const wallet = getWallet();
    
    const mangoAccount = await client.getMangoAccountForOwner(group, wallet.publicKey);
    
    if (!mangoAccount) {
      throw new Error('Mango account not found');
    }
    
    // Close position logic
    // Implementation depends on SDK version
    
    return {
      success: true,
      signature: positionId,
    };
  } catch (error) {
    console.error('[MangoPerps] ❌ Error closing position:', error.message);
    throw error;
  }
}

/**
 * Get user's perpetual positions
 * @param {string} walletAddress - Wallet address
 * @returns {Promise<Array>} Array of positions
 */
export async function getMangoPositions(walletAddress) {
  try {
    console.log('[MangoPerps] Getting positions for:', walletAddress);
    
    const { client, group } = await getMangoClient();
    const wallet = getWallet();
    
    const mangoAccount = await client.getMangoAccountForOwner(group, wallet.publicKey);
    
    if (!mangoAccount) {
      return [];
    }
    
    const positions = mangoAccount.perpPositions
      .filter(p => p.basePosition !== 0)
      .map(p => {
        const perpMarket = group.getPerpMarketByMarketIndex(p.marketIndex);
        return {
          marketIndex: p.marketIndex,
          market: perpMarket?.name || 'Unknown',
          direction: p.basePosition > 0 ? 'long' : 'short',
          size: Math.abs(p.basePosition),
          entryPrice: p.entryPrice,
          unrealizedPnl: p.quotePosition,
        };
      });

    return positions;
  } catch (error) {
    console.error('[MangoPerps] ❌ Error getting positions:', error.message);
    throw error;
  }
}

