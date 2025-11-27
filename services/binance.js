/**
 * Binance API Service
 * Fetches OHLCV candlestick data from Binance public API
 * No API key required for public endpoints
 * 
 * NOTE: If you get 451 errors (geo-restrictions), the system will
 * automatically fall back to CoinGecko API
 */

import axios from 'axios';

// Try multiple Binance endpoints (main, US, or proxies)
const BINANCE_ENDPOINTS = [
  'https://api.binance.com/api/v3',
  'https://api.binance.us/api/v3',
  'https://data.binance.com/api/v3'
];

let BINANCE_API_BASE = BINANCE_ENDPOINTS[0];

/**
 * Fetch candlestick data from Binance
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {string} interval - Timeframe (1m, 3m, 5m, 15m, 1h, 4h, 1d)
 * @param {number} limit - Number of candles to fetch (default: 500, max: 1000)
 * @returns {Promise<Array>} Array of candles with parsed OHLCV data
 */
export async function fetchKlines(symbol, interval, limit = 500) {
  try {
    const response = await axios.get(`${BINANCE_API_BASE}/klines`, {
      params: { symbol, interval, limit },
      timeout: 10000
    });

    // Parse Binance response
    // Response format: [timestamp, open, high, low, close, volume, closeTime, ...]
    const candles = response.data.map(candle => ({
      timestamp: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
      closeTime: candle[6]
    }));

    return candles;
  } catch (error) {
    console.error(`Error fetching ${symbol} ${interval} from Binance:`, error.message);
    throw new Error(`Failed to fetch data from Binance: ${error.message}`);
  }
}

/**
 * Fetch current spot price for a symbol
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @returns {Promise<Object>} Current price and 24h stats
 */
export async function fetchTickerPrice(symbol) {
  try {
    const response = await axios.get(`${BINANCE_API_BASE}/ticker/24hr`, {
      params: { symbol },
      timeout: 5000
    });

    return {
      symbol: response.data.symbol,
      price: parseFloat(response.data.lastPrice),
      priceChange: parseFloat(response.data.priceChange),
      priceChangePercent: parseFloat(response.data.priceChangePercent),
      high24h: parseFloat(response.data.highPrice),
      low24h: parseFloat(response.data.lowPrice),
      volume24h: parseFloat(response.data.volume)
    };
  } catch (error) {
    console.error(`Error fetching ticker for ${symbol}:`, error.message);
    throw new Error(`Failed to fetch ticker: ${error.message}`);
  }
}

/**
 * Fetch multi-timeframe data for a symbol
 * @param {string} symbol - Trading pair
 * @param {Array<string>} intervals - Array of timeframes
 * @returns {Promise<Object>} Object with data for each timeframe
 */
export async function fetchMultiTimeframe(symbol, intervals = ['4h', '1h', '15m', '5m']) {
  try {
    const promises = intervals.map(interval => 
      fetchKlines(symbol, interval, 500)
        .then(data => ({ interval, data }))
        .catch(err => ({ interval, error: err.message }))
    );

    const results = await Promise.all(promises);
    
    const multiData = {};
    results.forEach(result => {
      if (result.error) {
        multiData[result.interval] = { error: result.error };
      } else {
        multiData[result.interval] = result.data;
      }
    });

    return multiData;
  } catch (error) {
    console.error(`Error fetching multi-timeframe data:`, error.message);
    throw error;
  }
}

/**
 * Validate if a symbol exists on Binance
 * @param {string} symbol - Trading pair to validate
 * @returns {Promise<boolean>} True if symbol exists
 */
export async function validateSymbol(symbol) {
  try {
    await axios.get(`${BINANCE_API_BASE}/ticker/price`, {
      params: { symbol },
      timeout: 5000
    });
    return true;
  } catch (error) {
    return false;
  }
}

export default {
  fetchKlines,
  fetchTickerPrice,
  fetchMultiTimeframe,
  validateSymbol
};

