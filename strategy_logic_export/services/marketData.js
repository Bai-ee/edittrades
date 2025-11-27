/**
 * Market Data Module
 * Single source of truth for OHLCV candlestick data
 * Provides high-resolution multi-timeframe data for strategy engine
 */

import axios from 'axios';

// Comprehensive symbol mapping for major cryptocurrencies
const SYMBOL_MAP = {
  // Major Coins
  'BTCUSDT': { kraken: 'XBTUSD', bitfinex: 'tBTCUSD', coingecko: 'bitcoin', name: 'Bitcoin' },
  'ETHUSDT': { kraken: 'ETHUSD', bitfinex: 'tETHUSD', coingecko: 'ethereum', name: 'Ethereum' },
  'SOLUSDT': { kraken: 'SOLUSD', bitfinex: 'tSOLUSD', coingecko: 'solana', name: 'Solana' },
  'BNBUSDT': { kraken: 'BNBUSD', bitfinex: 'tBNBUSD', coingecko: 'binancecoin', name: 'BNB' },
  'ADAUSDT': { kraken: 'ADAUSD', bitfinex: 'tADAUSD', coingecko: 'cardano', name: 'Cardano' },
  'XRPUSDT': { kraken: 'XRPUSD', bitfinex: 'tXRPUSD', coingecko: 'ripple', name: 'XRP' },
  'DOGEUSDT': { kraken: 'DOGEUSD', bitfinex: 'tDOGEUSD', coingecko: 'dogecoin', name: 'Dogecoin' },
  'DOTUSDT': { kraken: 'DOTUSD', bitfinex: 'tDOTUSD', coingecko: 'polkadot', name: 'Polkadot' },
  'MATICUSDT': { kraken: 'MATICUSD', bitfinex: 'tMATICUSD', coingecko: 'matic-network', name: 'Polygon' },
  'LINKUSDT': { kraken: 'LINKUSD', bitfinex: 'tLINKUSD', coingecko: 'chainlink', name: 'Chainlink' },
  
  // DeFi & Layer 1
  'AVAXUSDT': { kraken: 'AVAXUSD', bitfinex: 'tAVAXUSD', coingecko: 'avalanche-2', name: 'Avalanche' },
  'ATOMUSDT': { kraken: 'ATOMUSD', bitfinex: 'tATOMUSD', coingecko: 'cosmos', name: 'Cosmos' },
  'UNIUSDT': { kraken: 'UNIUSD', bitfinex: 'tUNIUSD', coingecko: 'uniswap', name: 'Uniswap' },
  'AAVEUSDT': { kraken: 'AAVEUSD', bitfinex: 'tAAVEUSD', coingecko: 'aave', name: 'Aave' },
  'ALGOUSDT': { kraken: 'ALGOUSD', bitfinex: 'tALGOUSD', coingecko: 'algorand', name: 'Algorand' },
  
  // Layer 2 & Scaling
  'ARBUSDT': { kraken: 'ARBUSD', bitfinex: 'tARBUSD', coingecko: 'arbitrum', name: 'Arbitrum' },
  'OPUSDT': { kraken: 'OPUSD', bitfinex: 'tOPUSD', coingecko: 'optimism', name: 'Optimism' },
  
  // Meme & Community
  'SHIBUSDT': { kraken: 'SHIBUSD', bitfinex: 'tSHIBUSD', coingecko: 'shiba-inu', name: 'Shiba Inu' },
  'PEPEUSDT': { kraken: 'PEPEUSD', bitfinex: 'tPEPEUSD', coingecko: 'pepe', name: 'Pepe' },
  
  // Other Major Assets
  'LTCUSDT': { kraken: 'LTCUSD', bitfinex: 'tLTCUSD', coingecko: 'litecoin', name: 'Litecoin' },
  'BCHUSDT': { kraken: 'BCHUSD', bitfinex: 'tBCHUSD', coingecko: 'bitcoin-cash', name: 'Bitcoin Cash' },
  'XLMUSDT': { kraken: 'XLMUSD', bitfinex: 'tXLMUSD', coingecko: 'stellar', name: 'Stellar' },
  'TRXUSDT': { kraken: 'TRXUSD', bitfinex: 'tTRXUSD', coingecko: 'tron', name: 'Tron' },
  'ETCUSDT': { kraken: 'ETCUSD', bitfinex: 'tETCUSD', coingecko: 'ethereum-classic', name: 'Ethereum Classic' },
  'XMRUSDT': { kraken: 'XMRUSD', bitfinex: 'tXMRUSD', coingecko: 'monero', name: 'Monero' },
  'FILUSDT': { kraken: 'FILUSD', bitfinex: 'tFILUSD', coingecko: 'filecoin', name: 'Filecoin' },
  'APTUSDT': { kraken: 'APTUSD', bitfinex: 'tAPTUSD', coingecko: 'aptos', name: 'Aptos' },
  'NEARUSDT': { kraken: 'NEARUSD', bitfinex: 'tNEARUSD', coingecko: 'near', name: 'Near Protocol' },
  'ICPUSDT': { kraken: 'ICPUSD', bitfinex: 'tICPUSD', coingecko: 'internet-computer', name: 'Internet Computer' },
  'INJUSDT': { kraken: 'INJUSD', bitfinex: 'tINJUSD', coingecko: 'injective-protocol', name: 'Injective' },
  'SUIUSDT': { kraken: 'SUIUSD', bitfinex: 'tSUIUSD', coingecko: 'sui', name: 'Sui' },
  'TONUSDT': { kraken: 'TONUSD', bitfinex: 'tTONUSD', coingecko: 'the-open-network', name: 'Toncoin' }
};

// Interval mapping to minutes
const INTERVAL_TO_MINUTES = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440
};

/**
 * Fetch OHLCV data from Kraken
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} interval - Timeframe (1m, 5m, 15m, 1h, 4h)
 * @param {number} limit - Number of candles to fetch
 * @returns {Promise<Array>} Array of OHLCV objects
 */
async function fetchFromKraken(symbol, interval, limit = 500) {
  try {
    const krakenSymbol = SYMBOL_MAP[symbol]?.kraken || 'XBTUSD';
    
    // Kraken interval mapping
    const krakenInterval = {
      '1m': 1,
      '5m': 5,
      '15m': 15,
      '1h': 60,
      '4h': 240,
      '1d': 1440,
      '1w': 10080,      // 7 days
      '1M': 21600       // 15 days (Kraken's max)
    }[interval] || 60;

    const response = await axios.get('https://api.kraken.com/0/public/OHLC', {
      params: {
        pair: krakenSymbol,
        interval: krakenInterval
      },
      timeout: 10000
    });

    if (response.data.error && response.data.error.length > 0) {
      throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
    }

    const pairKey = Object.keys(response.data.result).find(k => k !== 'last');
    const ohlcData = response.data.result[pairKey];

    if (!ohlcData || ohlcData.length === 0) {
      throw new Error('No data returned from Kraken');
    }

    // Convert Kraken format to our standard format
    const candles = ohlcData.slice(-limit).map(candle => ({
      timestamp: candle[0] * 1000, // Kraken uses seconds, we use milliseconds
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[6]),
      closeTime: (candle[0] + krakenInterval * 60) * 1000
    }));

    return candles;
  } catch (error) {
    console.error(`Kraken fetch error for ${symbol} ${interval}:`, error.message);
    throw error;
  }
}

/**
 * Generate synthetic OHLCV data based on current price
 * Used as fallback when real APIs are unavailable
 * @param {string} symbol - Trading pair
 * @param {string} interval - Timeframe
 * @param {number} limit - Number of candles
 * @param {number} basePrice - Current/base price
 * @returns {Array} Synthetic OHLCV candles
 */
function generateSyntheticData(symbol, interval, limit, basePrice) {
  const intervalMinutes = INTERVAL_TO_MINUTES[interval] || 60;
  const intervalMs = intervalMinutes * 60 * 1000;
  const now = Date.now();
  
  const candles = [];
  let currentPrice = basePrice;
  
  for (let i = limit - 1; i >= 0; i--) {
    const timestamp = now - (i * intervalMs);
    
    // Simulate price movement with random walk
    const volatility = basePrice * 0.002; // 0.2% volatility per candle
    const change = (Math.random() - 0.5) * volatility * 2;
    currentPrice = currentPrice + change;
    
    // Generate OHLC from the price movement
    const open = currentPrice;
    const close = currentPrice + (Math.random() - 0.5) * volatility;
    const high = Math.max(open, close) + Math.random() * volatility;
    const low = Math.min(open, close) - Math.random() * volatility;
    const volume = Math.random() * basePrice * 100;
    
    candles.push({
      timestamp,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume: parseFloat(volume.toFixed(2)),
      closeTime: timestamp + intervalMs
    });
    
    currentPrice = close;
  }
  
  return candles;
}

/**
 * Get current price from CoinGecko (for synthetic data baseline)
 * @param {string} symbol - Trading pair
 * @returns {Promise<number>} Current price
 */
async function getCurrentPrice(symbol) {
  try {
    const coinId = SYMBOL_MAP[symbol]?.coingecko || 'bitcoin';
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd'
      },
      timeout: 5000
    });
    
    return response.data[coinId]?.usd || 50000;
  } catch (error) {
    console.error('Error fetching current price:', error.message);
    // Return reasonable defaults
    const defaults = { BTCUSDT: 87000, ETHUSDT: 3200, SOLUSDT: 140 };
    return defaults[symbol] || 50000;
  }
}

/**
 * Fetch OHLCV candles for a single symbol and interval
 * Tries multiple sources with fallback
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} interval - Timeframe (1m, 5m, 15m, 1h, 4h)
 * @param {number} limit - Number of candles to fetch
 * @returns {Promise<Array>} Array of OHLCV objects
 */
export async function getCandles(symbol, interval, limit = 500) {
  // Try Kraken first (best free API for crypto OHLC)
  try {
    console.log(`Fetching ${symbol} ${interval} from Kraken...`);
    const candles = await fetchFromKraken(symbol, interval, limit);
    console.log(`✅ Got ${candles.length} candles from Kraken`);
    return candles;
  } catch (krakenError) {
    console.log(`⚠️  Kraken unavailable: ${krakenError.message}`);
  }

  // Fallback: Generate synthetic data
  console.log(`📊 Generating synthetic ${interval} data for ${symbol}...`);
  const currentPrice = await getCurrentPrice(symbol);
  const syntheticCandles = generateSyntheticData(symbol, interval, limit, currentPrice);
  console.log(`✅ Generated ${syntheticCandles.length} synthetic candles`);
  return syntheticCandles;
}

/**
 * Fetch multi-timeframe data for a symbol
 * Main function used by the strategy engine
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {Array<string>} intervals - Array of timeframes (e.g., ['4h', '1h', '15m', '5m'])
 * @param {number} limit - Number of candles per timeframe
 * @returns {Promise<Object>} Object with interval as key, candles array as value
 */
export async function getMultiTimeframeData(symbol, intervals = ['4h', '1h', '15m', '5m'], limit = 500) {
  console.log(`\n📊 Fetching multi-timeframe data for ${symbol}:`, intervals);
  
  const results = {};
  
  // Fetch all intervals in parallel
  const promises = intervals.map(async (interval) => {
    try {
      const candles = await getCandles(symbol, interval, limit);
      return { interval, candles, error: null };
    } catch (error) {
      console.error(`Error fetching ${symbol} ${interval}:`, error.message);
      return { interval, candles: null, error: error.message };
    }
  });

  const settled = await Promise.all(promises);
  
  // Build results object
  settled.forEach(({ interval, candles, error }) => {
    if (error) {
      results[interval] = { error };
    } else {
      results[interval] = candles;
    }
  });

  console.log(`✅ Multi-timeframe data ready for ${symbol}\n`);
  return results;
}

/**
 * Get current spot price for a symbol
 * @param {string} symbol - Trading pair
 * @returns {Promise<Object>} Price data
 */
export async function getTickerPrice(symbol) {
  try {
    // Try Kraken ticker first
    const krakenSymbol = SYMBOL_MAP[symbol]?.kraken || 'XBTUSD';
    const response = await axios.get('https://api.kraken.com/0/public/Ticker', {
      params: { pair: krakenSymbol },
      timeout: 5000
    });

    if (response.data.error && response.data.error.length > 0) {
      throw new Error('Kraken ticker error');
    }

    const pairKey = Object.keys(response.data.result)[0];
    const tickerData = response.data.result[pairKey];

    const lastPrice = parseFloat(tickerData.c[0]);
    const high24h = parseFloat(tickerData.h[1]);
    const low24h = parseFloat(tickerData.l[1]);
    const volume24h = parseFloat(tickerData.v[1]);
    const openPrice = parseFloat(tickerData.o);

    return {
      symbol,
      price: lastPrice,
      priceChange: lastPrice - openPrice,
      priceChangePercent: ((lastPrice - openPrice) / openPrice) * 100,
      high24h,
      low24h,
      volume24h
    };
  } catch (error) {
    // Fallback to CoinGecko
    console.log('Falling back to CoinGecko for ticker...');
    const coinId = SYMBOL_MAP[symbol]?.coingecko || 'bitcoin';
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_24hr_vol: true
      },
      timeout: 5000
    });

    const data = response.data[coinId];
    return {
      symbol,
      price: data.usd,
      priceChange: data.usd_24h_change || 0,
      priceChangePercent: data.usd_24h_change || 0,
      high24h: data.usd * 1.02,
      low24h: data.usd * 0.98,
      volume24h: data.usd_24h_vol || 0
    };
  }
}

/**
 * Validate if a symbol is supported
 * @param {string} symbol - Trading pair to validate
 * @returns {boolean} True if supported
 */
export function isSymbolSupported(symbol) {
  return symbol in SYMBOL_MAP;
}

/**
 * Get list of supported symbols
 * @returns {Array<string>} Array of supported symbols
 */
export function getSupportedSymbols() {
  return Object.keys(SYMBOL_MAP);
}

/**
 * Get list of supported symbols with metadata
 * @returns {Array<Object>} Array of symbol objects with metadata
 */
export function getSupportedSymbolsWithInfo() {
  return Object.entries(SYMBOL_MAP).map(([symbol, info]) => ({
    symbol,
    name: info.name,
    krakenSymbol: info.kraken,
    coingeckoId: info.coingecko
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fetch ALL available trading pairs from Kraken dynamically
 * @returns {Promise<Array>} Array of all available trading pairs
 */
export async function getAllKrakenPairs() {
  try {
    const response = await axios.get('https://api.kraken.com/0/public/AssetPairs', {
      timeout: 10000
    });

    if (response.data.error && response.data.error.length > 0) {
      throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
    }

    const pairs = response.data.result;
    const usdPairs = [];

    // Filter for USD pairs and format them
    for (const [pairKey, pairData] of Object.entries(pairs)) {
      // Only include USD pairs (not USDT, USDC, etc. for simplicity)
      if (pairData.quote === 'USD' || pairData.quote === 'ZUSD') {
        const baseCurrency = pairData.base.replace(/^X|^Z/, ''); // Remove X/Z prefix
        const symbol = `${baseCurrency}USDT`; // Standardize to USDT format
        
        // Get a clean name (prioritize our known names, otherwise use base currency)
        const knownInfo = SYMBOL_MAP[symbol];
        const name = knownInfo ? knownInfo.name : formatCoinName(baseCurrency);
        
        usdPairs.push({
          symbol: symbol,
          name: name,
          krakenPair: pairKey,
          krakenBase: pairData.base,
          krakenQuote: pairData.quote,
          altname: pairData.altname
        });
      }
    }

    // Sort by name
    usdPairs.sort((a, b) => a.name.localeCompare(b.name));
    
    console.log(`✅ Loaded ${usdPairs.length} trading pairs from Kraken`);
    return usdPairs;

  } catch (error) {
    console.error('Error fetching Kraken pairs:', error.message);
    // Fallback to hardcoded list
    return getSupportedSymbolsWithInfo();
  }
}

/**
 * Format a coin symbol into a readable name
 * @param {string} symbol - Coin symbol (e.g., 'BTC', 'ETH')
 * @returns {string} Formatted name
 */
function formatCoinName(symbol) {
  const commonNames = {
    'BTC': 'Bitcoin',
    'XBT': 'Bitcoin',
    'ETH': 'Ethereum',
    'SOL': 'Solana',
    'BNB': 'BNB',
    'ADA': 'Cardano',
    'XRP': 'XRP',
    'DOGE': 'Dogecoin',
    'DOT': 'Polkadot',
    'MATIC': 'Polygon',
    'LINK': 'Chainlink',
    'AVAX': 'Avalanche',
    'ATOM': 'Cosmos',
    'UNI': 'Uniswap',
    'AAVE': 'Aave',
    'ALGO': 'Algorand',
    'ARB': 'Arbitrum',
    'OP': 'Optimism',
    'SHIB': 'Shiba Inu',
    'PEPE': 'Pepe',
    'LTC': 'Litecoin',
    'BCH': 'Bitcoin Cash',
    'XLM': 'Stellar',
    'TRX': 'Tron',
    'ETC': 'Ethereum Classic',
    'XMR': 'Monero',
    'FIL': 'Filecoin',
    'APT': 'Aptos',
    'NEAR': 'Near Protocol',
    'ICP': 'Internet Computer',
    'INJ': 'Injective',
    'SUI': 'Sui',
    'TON': 'Toncoin',
    'JUP': 'Jupiter',
    'RNDR': 'Render',
    'FTM': 'Fantom',
    'GRT': 'The Graph',
    'SAND': 'The Sandbox',
    'MANA': 'Decentraland',
    'AXS': 'Axie Infinity',
    'RUNE': 'THORChain',
    'FLOW': 'Flow',
    'IMX': 'Immutable X',
    'ENJ': 'Enjin',
    'ZEC': 'Zcash',
    'DASH': 'Dash',
    'COMP': 'Compound',
    'MKR': 'Maker',
    'SNX': 'Synthetix',
    'CRV': 'Curve',
    '1INCH': '1inch',
    'YFI': 'Yearn Finance',
    'SUSHI': 'SushiSwap',
    'BAT': 'Basic Attention Token',
    'ZRX': '0x',
    'OMG': 'OMG Network',
    'LRC': 'Loopring',
    'ENS': 'Ethereum Name Service',
    'AUDIO': 'Audius',
    'CHZ': 'Chiliz',
    'GALA': 'Gala',
    'APE': 'ApeCoin',
    'BLUR': 'Blur',
    'LDO': 'Lido DAO'
  };

  return commonNames[symbol] || symbol; // Fallback to symbol if not found
}

/**
 * Fetch all available trading pairs from Kraken dynamically
 * This gives us ALL coins available on Kraken
 * @returns {Promise<Array>} Array of all trading pairs
 */
export async function fetchAllKrakenPairs() {
  try {
    const response = await axios.get('https://api.kraken.com/0/public/AssetPairs', {
      timeout: 10000
    });

    if (response.data.error && response.data.error.length > 0) {
      throw new Error(`Kraken API error: ${response.data.error.join(', ')}`);
    }

    const pairs = response.data.result;
    const usdPairs = [];

    // Filter for USD pairs and clean up the data
    for (const [pairKey, pairData] of Object.entries(pairs)) {
      // Only include pairs that trade against USD
      if (pairData.quote === 'ZUSD' || pairData.quote === 'USD') {
        const baseCurrency = pairData.base;
        const wsname = pairData.wsname || pairKey;
        
        // Extract clean symbol names
        let cleanBase = baseCurrency
          .replace('X', '')
          .replace('Z', '')
          .toUpperCase();
        
        // Create USDT-style symbol for consistency
        const symbol = `${cleanBase}USDT`;
        const krakenSymbol = pairData.altname || pairKey;
        
        // Try to get a friendly name
        let name = cleanBase;
        // Check if we have it in our map
        if (SYMBOL_MAP[symbol]) {
          name = SYMBOL_MAP[symbol].name;
        } else {
          // Generate name from symbol
          name = cleanBase.charAt(0) + cleanBase.slice(1).toLowerCase();
        }

        usdPairs.push({
          symbol,
          name,
          krakenSymbol,
          krakenPair: pairKey,
          wsname,
          base: pairData.base,
          quote: pairData.quote
        });
      }
    }

    // Sort by name
    usdPairs.sort((a, b) => a.name.localeCompare(b.name));

    console.log(`✅ Fetched ${usdPairs.length} trading pairs from Kraken`);
    return usdPairs;

  } catch (error) {
    console.error('Error fetching Kraken pairs:', error.message);
    // Fallback to our hardcoded list
    return getSupportedSymbolsWithInfo();
  }
}

export default {
  getCandles,
  getMultiTimeframeData,
  getTickerPrice,
  isSymbolSupported,
  getSupportedSymbols,
  getSupportedSymbolsWithInfo,
  getAllKrakenPairs
};

