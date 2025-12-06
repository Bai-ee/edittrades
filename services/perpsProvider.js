/**
 * Unified Perpetuals Provider Interface
 * Provides a single interface for multiple perpetuals providers (Drift, Mango, Jupiter)
 * Implements fallback logic: try Drift first, then Mango, then Jupiter
 */

import * as driftPerps from './driftPerps.js';
import * as mangoPerps from './mangoPerps.js';
import * as jupiterPerps from './jupiterPerps.js';

// Provider priority order (try in this order)
// Note: Jupiter is excluded due to custody capacity limits
const PROVIDER_PRIORITY = ['drift', 'mango'];

/**
 * Get available markets from all providers
 * @param {string} provider - Specific provider ('drift', 'mango', 'jupiter') or 'all'
 * @returns {Promise<Object>} Available markets
 */
export async function getPerpMarkets(provider = 'all') {
  if (provider !== 'all') {
    return await getMarketsFromProvider(provider);
  }

  // Get markets from all providers
  const allMarkets = {};
  
  for (const prov of PROVIDER_PRIORITY) {
    try {
      const markets = await getMarketsFromProvider(prov);
      allMarkets[prov] = markets;
    } catch (error) {
      console.warn(`[PerpsProvider] Could not get markets from ${prov}:`, error.message);
      allMarkets[prov] = { error: error.message };
    }
  }

  return allMarkets;
}

/**
 * Get markets from a specific provider
 * @param {string} provider - Provider name
 * @returns {Promise<Object>} Markets
 */
async function getMarketsFromProvider(provider) {
  switch (provider) {
    case 'drift':
      return await driftPerps.getDriftMarkets();
    case 'mango':
      return await mangoPerps.getMangoMarkets();
    case 'jupiter':
      return await jupiterPerps.getPerpMarkets();
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Get quote for perpetual position
 * @param {string} provider - Provider name or 'auto' for automatic selection
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier
 * @returns {Promise<Object>} Quote with provider info
 */
export async function getPerpQuote(provider, market, direction, size, leverage) {
  if (provider === 'auto') {
    // Try providers in priority order
    for (const prov of PROVIDER_PRIORITY) {
      try {
        const quote = await getQuoteFromProvider(prov, market, direction, size, leverage);
        return { ...quote, provider: prov, selectedProvider: prov };
      } catch (error) {
        console.warn(`[PerpsProvider] ${prov} quote failed:`, error.message);
        continue;
      }
    }
    throw new Error('All providers failed to provide quote');
  }

  const quote = await getQuoteFromProvider(provider, market, direction, size, leverage);
  return { ...quote, provider, selectedProvider: provider };
}

/**
 * Get quote from a specific provider
 * @param {string} provider - Provider name
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier
 * @returns {Promise<Object>} Quote
 */
async function getQuoteFromProvider(provider, market, direction, size, leverage) {
  switch (provider) {
    case 'drift':
      return await driftPerps.getDriftQuote(market, direction, size, leverage);
    case 'mango':
      return await mangoPerps.getMangoQuote(market, direction, size, leverage);
    case 'jupiter':
      return await jupiterPerps.getPerpQuote(market, direction, size, leverage);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Open a perpetual position with automatic provider fallback
 * @param {string} provider - Provider name or 'auto' for automatic selection
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier
 * @param {number} stopLoss - Stop loss price (optional)
 * @param {number} takeProfit - Take profit price (optional)
 * @returns {Promise<Object>} Execution result
 */
export async function openPerpPosition(provider, market, direction, size, leverage, stopLoss = null, takeProfit = null) {
  if (provider === 'auto') {
    // Try providers in priority order with fallback
    const errors = [];
    
    for (const prov of PROVIDER_PRIORITY) {
      try {
        console.log(`[PerpsProvider] Trying ${prov}...`);
        const result = await openPositionFromProvider(prov, market, direction, size, leverage, stopLoss, takeProfit);
        console.log(`[PerpsProvider] ✅ Success with ${prov}`);
        return { ...result, provider: prov, selectedProvider: prov, fallbackUsed: prov !== PROVIDER_PRIORITY[0] };
      } catch (error) {
        console.warn(`[PerpsProvider] ❌ ${prov} failed:`, error.message);
        errors.push({ provider: prov, error: error.message });
        
        // Check if error is capacity-related (should try next provider)
        if (error.message.includes('CustodyAmountLimit') || 
            error.message.includes('capacity') || 
            error.message.includes('limit exceeded')) {
          console.log(`[PerpsProvider] Capacity issue with ${prov}, trying next provider...`);
          continue;
        }
        
        // For other errors, we might still want to try next provider
        // But log the error
        continue;
      }
    }
    
    // All providers failed
    throw new Error(`All providers failed. Errors: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`);
  }

  // Use specific provider
  const result = await openPositionFromProvider(provider, market, direction, size, leverage, stopLoss, takeProfit);
  return { ...result, provider, selectedProvider: provider };
}

/**
 * Open position from a specific provider
 * @param {string} provider - Provider name
 * @param {string} market - Market symbol
 * @param {string} direction - 'long' or 'short'
 * @param {number} size - Position size in USD
 * @param {number} leverage - Leverage multiplier
 * @param {number} stopLoss - Stop loss price (optional)
 * @param {number} takeProfit - Take profit price (optional)
 * @returns {Promise<Object>} Execution result
 */
async function openPositionFromProvider(provider, market, direction, size, leverage, stopLoss, takeProfit) {
  switch (provider) {
    case 'drift':
      return await driftPerps.openDriftPosition(market, direction, size, leverage, stopLoss, takeProfit);
    case 'mango':
      return await mangoPerps.openMangoPosition(market, direction, size, leverage, stopLoss, takeProfit);
    case 'jupiter':
      return await jupiterPerps.openPerpPosition(market, direction, size, leverage, stopLoss, takeProfit);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Close a perpetual position
 * @param {string} provider - Provider name
 * @param {string} positionId - Position ID
 * @returns {Promise<Object>} Close result
 */
export async function closePerpPosition(provider, positionId) {
  switch (provider) {
    case 'drift':
      return await driftPerps.closeDriftPosition(positionId);
    case 'mango':
      return await mangoPerps.closeMangoPosition(positionId);
    case 'jupiter':
      return await jupiterPerps.closePerpPosition(positionId);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Get user's perpetual positions
 * @param {string} provider - Provider name or 'all'
 * @param {string} walletAddress - Wallet address
 * @returns {Promise<Object|Array>} Positions
 */
export async function getPerpPositions(provider, walletAddress) {
  if (provider === 'all') {
    const allPositions = {};
    
    for (const prov of PROVIDER_PRIORITY) {
      try {
        const positions = await getPositionsFromProvider(prov, walletAddress);
        allPositions[prov] = positions;
      } catch (error) {
        console.warn(`[PerpsProvider] Could not get positions from ${prov}:`, error.message);
        allPositions[prov] = [];
      }
    }
    
    return allPositions;
  }

  return await getPositionsFromProvider(provider, walletAddress);
}

/**
 * Get positions from a specific provider
 * @param {string} provider - Provider name
 * @param {string} walletAddress - Wallet address
 * @returns {Promise<Array>} Positions
 */
async function getPositionsFromProvider(provider, walletAddress) {
  switch (provider) {
    case 'drift':
      return await driftPerps.getDriftPositions(walletAddress);
    case 'mango':
      return await mangoPerps.getMangoPositions(walletAddress);
    case 'jupiter':
      return await jupiterPerps.getPerpPositions(walletAddress);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

/**
 * Get provider information
 * @returns {Object} Provider info
 */
export function getProviderInfo() {
  return {
    available: PROVIDER_PRIORITY,
    priority: PROVIDER_PRIORITY,
    default: 'auto', // Auto-select with fallback
  };
}


