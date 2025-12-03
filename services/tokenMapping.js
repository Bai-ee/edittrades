/**
 * Token Mapping Service
 * Maps Kraken trading symbols to Solana SPL token addresses
 * Supports BTC/ETH/SOL for MVP, easily extensible for more tokens
 */

/**
 * Token address mapping
 * Maps Kraken symbols to Solana token mint addresses
 */
const TOKEN_ADDRESSES = {
  // Native SOL
  'SOL': 'So11111111111111111111111111111111111111112',
  'SOLUSDT': 'So11111111111111111111111111111111111111112',
  
  // Wrapped Bitcoin on Solana (WBTC)
  // TODO: Verify actual WBTC token address on Solana mainnet
  'BTC': '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC placeholder - verify address
  'BTCUSDT': '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  
  // Wrapped Ethereum on Solana (WETH)
  // TODO: Verify actual WETH token address on Solana mainnet
  'ETH': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH placeholder - verify address
  'ETHUSDT': '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  
  // Stablecoins
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

/**
 * Token decimals mapping
 * Standard decimals for each token
 */
const TOKEN_DECIMALS = {
  'SOL': 9,
  'SOLUSDT': 9,
  'BTC': 8,
  'BTCUSDT': 8,
  'ETH': 8,
  'ETHUSDT': 8,
  'USDC': 6,
  'USDT': 6,
};

/**
 * Get Solana token address for a trading symbol
 * @param {string} symbol - Trading symbol (e.g., 'BTCUSDT', 'ETHUSDT', 'SOLUSDT')
 * @returns {string|null} Solana token mint address or null if not found
 */
export function getTokenAddress(symbol) {
  if (!symbol) {
    console.error('[TokenMapping] Symbol is required');
    return null;
  }

  const normalizedSymbol = symbol.toUpperCase();
  const address = TOKEN_ADDRESSES[normalizedSymbol];

  if (!address) {
    console.warn(`[TokenMapping] Token address not found for symbol: ${symbol}`);
    console.warn('[TokenMapping] Available symbols:', Object.keys(TOKEN_ADDRESSES).join(', '));
    return null;
  }

  console.log(`[TokenMapping] Mapped ${symbol} to ${address}`);
  return address;
}

/**
 * Get token decimals for a trading symbol
 * @param {string} symbol - Trading symbol
 * @returns {number} Token decimals (default: 9 for SOL)
 */
export function getTokenDecimals(symbol) {
  if (!symbol) {
    return 9; // Default to SOL decimals
  }

  const normalizedSymbol = symbol.toUpperCase();
  const decimals = TOKEN_DECIMALS[normalizedSymbol] || 9;

  return decimals;
}

/**
 * Convert amount to token's smallest unit (lamports/wei)
 * @param {number} amount - Amount in human-readable format
 * @param {string} symbol - Trading symbol
 * @returns {number} Amount in smallest unit
 */
export function toTokenAmount(amount, symbol) {
  const decimals = getTokenDecimals(symbol);
  return Math.floor(amount * Math.pow(10, decimals));
}

/**
 * Convert amount from token's smallest unit to human-readable
 * @param {number} amount - Amount in smallest unit
 * @param {string} symbol - Trading symbol
 * @returns {number} Amount in human-readable format
 */
export function fromTokenAmount(amount, symbol) {
  const decimals = getTokenDecimals(symbol);
  return amount / Math.pow(10, decimals);
}

/**
 * Check if symbol is supported
 * @param {string} symbol - Trading symbol
 * @returns {boolean} True if symbol is supported
 */
export function isSymbolSupported(symbol) {
  if (!symbol) return false;
  const normalizedSymbol = symbol.toUpperCase();
  return TOKEN_ADDRESSES.hasOwnProperty(normalizedSymbol);
}

/**
 * Get all supported symbols
 * @returns {string[]} Array of supported symbols
 */
export function getSupportedSymbols() {
  return Object.keys(TOKEN_ADDRESSES);
}

/**
 * Add a new token mapping (for future extension)
 * @param {string} symbol - Trading symbol
 * @param {string} address - Solana token mint address
 * @param {number} decimals - Token decimals
 */
export function addTokenMapping(symbol, address, decimals = 9) {
  const normalizedSymbol = symbol.toUpperCase();
  TOKEN_ADDRESSES[normalizedSymbol] = address;
  TOKEN_DECIMALS[normalizedSymbol] = decimals;
  console.log(`[TokenMapping] Added new token mapping: ${normalizedSymbol} -> ${address} (${decimals} decimals)`);
}

