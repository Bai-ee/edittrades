/**
 * CoinGecko API Service (Alternative to Binance)
 * Free API with global access, no restrictions
 */

import axios from 'axios';

const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// Map common symbols to CoinGecko IDs
const SYMBOL_MAP = {
  'BTCUSDT': 'bitcoin',
  'ETHUSDT': 'ethereum',
  'SOLUSDT': 'solana',
  'BNBUSDT': 'binancecoin',
  'ADAUSDT': 'cardano',
  'DOGEUSDT': 'dogecoin',
  'XRPUSDT': 'ripple',
  'DOTUSDT': 'polkadot',
  'MATICUSDT': 'matic-network',
  'LINKUSDT': 'chainlink'
};

// Interval mapping (CoinGecko doesn't have all intervals)
const INTERVAL_TO_DAYS = {
  '1m': 1,
  '3m': 1,
  '5m': 1,
  '15m': 1,
  '1h': 7,
  '4h': 30,
  '1d': 90
};

/**
 * Get coin ID from symbol
 */
function getCoinId(symbol) {
  return SYMBOL_MAP[symbol.toUpperCase()] || symbol.toLowerCase().replace('usdt', '');
}

/**
 * Fetch OHLC data from CoinGecko
 * Note: CoinGecko's OHLC is limited to daily candles on free tier
 */
export async function fetchKlines(symbol, interval, limit = 500) {
  try {
    const coinId = getCoinId(symbol);
    const days = INTERVAL_TO_DAYS[interval] || 30;

    // CoinGecko OHLC endpoint (returns daily data)
    const response = await axios.get(`${COINGECKO_API_BASE}/coins/${coinId}/ohlc`, {
      params: { 
        vs_currency: 'usd',
        days: Math.min(days, 365)
      },
      timeout: 10000
    });

    // Transform to our format
    // CoinGecko returns: [timestamp, open, high, low, close]
    const candles = response.data.slice(-limit).map(candle => ({
      timestamp: candle[0],
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: 0, // CoinGecko OHLC doesn't include volume
      closeTime: candle[0] + (24 * 60 * 60 * 1000) // Add 1 day
    }));

    return candles;
  } catch (error) {
    console.error(`Error fetching ${symbol} from CoinGecko:`, error.message);
    throw new Error(`Failed to fetch data from CoinGecko: ${error.message}`);
  }
}

/**
 * Fetch current price and 24h stats
 */
export async function fetchTickerPrice(symbol) {
  try {
    const coinId = getCoinId(symbol);
    
    const response = await axios.get(`${COINGECKO_API_BASE}/simple/price`, {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_24hr_vol: true
      },
      timeout: 5000
    });

    const data = response.data[coinId];
    
    if (!data) {
      throw new Error(`Symbol ${symbol} not found on CoinGecko`);
    }

    return {
      symbol: symbol.toUpperCase(),
      price: data.usd,
      priceChange: data.usd_24h_change || 0,
      priceChangePercent: data.usd_24h_change || 0,
      high24h: data.usd * 1.02, // Estimated (CoinGecko simple API doesn't provide)
      low24h: data.usd * 0.98,  // Estimated
      volume24h: data.usd_24h_vol || 0
    };
  } catch (error) {
    console.error(`Error fetching ticker from CoinGecko:`, error.message);
    throw new Error(`Failed to fetch ticker: ${error.message}`);
  }
}

/**
 * Fetch multi-timeframe data
 * Note: CoinGecko free tier has limitations, so we'll return same data for all intervals
 */
export async function fetchMultiTimeframe(symbol, intervals = ['4h', '1h', '15m', '5m']) {
  try {
    const coinId = getCoinId(symbol);
    
    // Fetch market chart (more granular than OHLC)
    const response = await axios.get(`${COINGECKO_API_BASE}/coins/${coinId}/market_chart`, {
      params: { 
        vs_currency: 'usd',
        days: 30,
        interval: 'daily'
      },
      timeout: 10000
    });

    // Convert price data to OHLCV format (simplified)
    const prices = response.data.prices;
    const candles = [];
    
    for (let i = 0; i < prices.length; i++) {
      const timestamp = prices[i][0];
      const price = prices[i][1];
      
      candles.push({
        timestamp,
        open: price,
        high: price * 1.01,
        low: price * 0.99,
        close: price,
        volume: 0,
        closeTime: timestamp + (24 * 60 * 60 * 1000)
      });
    }

    // Return same data for all intervals (limitation of free tier)
    const multiData = {};
    intervals.forEach(interval => {
      multiData[interval] = candles;
    });

    return multiData;
  } catch (error) {
    console.error(`Error fetching multi-timeframe from CoinGecko:`, error.message);
    throw error;
  }
}

export default {
  fetchKlines,
  fetchTickerPrice,
  fetchMultiTimeframe
};






