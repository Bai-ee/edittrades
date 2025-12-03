/**
 * dFlow/Pond Prediction Markets API Service
 * Fetches prediction market data for crypto assets (BTC, ETH, SOL)
 * 
 * API Documentation: https://pond.dflow.net/concepts/overview
 */

import axios from 'axios';

// Base URLs for dFlow API endpoints
// Note: These endpoints may need adjustment based on actual dFlow API documentation
// If API is unavailable, the system will gracefully degrade
const DFLOw_BASE_URL = 'https://api.dflow.net';
const DFLOw_METADATA_URL = `${DFLOw_BASE_URL}/metadata`;
const DFLOw_LIVE_DATA_URL = `${DFLOw_BASE_URL}/live`;
const DFLOw_QUOTE_URL = 'https://quote-api.dflow.net';

// Symbol to dFlow ticker mapping
const SYMBOL_TO_TICKER = {
  'BTCUSDT': 'BTC',
  'ETHUSDT': 'ETH',
  'SOLUSDT': 'SOL'
};

// Cache for API responses (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached data or fetch fresh
 */
function getCached(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Search for events related to a symbol
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @returns {Promise<Array>} Array of events
 */
export async function searchEvents(symbol) {
  const ticker = SYMBOL_TO_TICKER[symbol];
  if (!ticker) {
    return [];
  }

  const cacheKey = `events_${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    // Search for events with ticker filter
    const response = await axios.get(`${DFLOw_METADATA_URL}/events`, {
      params: {
        ticker: ticker,
        limit: 20,
        status: 'active' // Only active markets
      },
      timeout: 10000
    });

    const events = response.data?.events || response.data || [];
    setCache(cacheKey, events);
    return events;
  } catch (error) {
    console.error(`[dFlow] Error fetching events for ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Get markets for a specific event
 * @param {string} eventId - Event ID
 * @returns {Promise<Array>} Array of markets
 */
export async function getMarketsByEvent(eventId) {
  const cacheKey = `markets_${eventId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${DFLOw_METADATA_URL}/markets`, {
      params: {
        eventId: eventId
      },
      timeout: 10000
    });

    const markets = response.data?.markets || response.data || [];
    setCache(cacheKey, markets);
    return markets;
  } catch (error) {
    console.error(`[dFlow] Error fetching markets for event ${eventId}:`, error.message);
    return [];
  }
}

/**
 * Get outcome mints (YES/NO tokens) for a market
 * @param {string} marketId - Market ID
 * @returns {Promise<Object>} Object with yesMint and noMint
 */
export async function getOutcomeMints(marketId) {
  const cacheKey = `mints_${marketId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${DFLOw_METADATA_URL}/outcome-mints`, {
      params: {
        marketId: marketId
      },
      timeout: 10000
    });

    const mints = response.data || {};
    setCache(cacheKey, mints);
    return mints;
  } catch (error) {
    console.error(`[dFlow] Error fetching outcome mints for market ${marketId}:`, error.message);
    return { yesMint: null, noMint: null };
  }
}

/**
 * Get live data (odds, prices, volume) for a market
 * @param {string} marketId - Market ID or mint address
 * @returns {Promise<Object>} Live data object
 */
export async function getLiveData(marketId) {
  const cacheKey = `live_${marketId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${DFLOw_LIVE_DATA_URL}/market/${marketId}`, {
      timeout: 10000
    });

    const liveData = response.data || {};
    setCache(cacheKey, liveData);
    return liveData;
  } catch (error) {
    console.error(`[dFlow] Error fetching live data for ${marketId}:`, error.message);
    return null;
  }
}

/**
 * Get all prediction market data for a symbol
 * Combines events, markets, mints, and live data
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @returns {Promise<Object>} Complete prediction market data
 */
export async function getPredictionMarkets(symbol) {
  const ticker = SYMBOL_TO_TICKER[symbol];
  if (!ticker) {
    return {
      symbol,
      error: 'Symbol not supported for prediction markets',
      events: [],
      markets: []
    };
  }

  try {
    // Search for events related to this symbol
    const events = await searchEvents(symbol);
    
    if (!events || events.length === 0) {
      return {
        symbol,
        ticker,
        events: [],
        markets: [],
        message: 'No prediction markets found for this symbol'
      };
    }

    // For each event, get markets and live data
    const marketsWithData = [];
    
    for (const event of events.slice(0, 10)) { // Limit to 10 events
      const eventId = event.id || event.eventId;
      const markets = await getMarketsByEvent(eventId);
      
      for (const market of markets) {
        const marketId = market.id || market.marketId;
        
        // Get outcome mints
        const mints = await getOutcomeMints(marketId);
        
        // Get live data
        const liveData = await getLiveData(marketId);
        
        // Calculate implied probabilities from prices
        const yesPrice = liveData?.yesPrice || market.yesPrice || 0;
        const noPrice = liveData?.noPrice || market.noPrice || 0;
        const yesProb = yesPrice > 0 ? (yesPrice / (yesPrice + noPrice)) * 100 : null;
        const noProb = noPrice > 0 ? (noPrice / (yesPrice + noPrice)) * 100 : null;
        
        // Calculate time to expiry
        const expiryTime = event.expiry || event.expiryTime;
        const timeToExpiry = expiryTime ? new Date(expiryTime) - new Date() : null;
        const hoursToExpiry = timeToExpiry ? Math.floor(timeToExpiry / (1000 * 60 * 60)) : null;
        
        marketsWithData.push({
          eventId: eventId,
          eventTitle: event.title || event.name || 'Unknown Event',
          marketId: marketId,
          marketType: market.type || 'YES/NO',
          status: event.status || market.status || 'active',
          expiry: expiryTime,
          hoursToExpiry: hoursToExpiry,
          yesPrice: yesPrice,
          noPrice: noPrice,
          yesProbability: yesProb,
          noProbability: noProb,
          volume: liveData?.volume || market.volume || 0,
          liquidity: liveData?.liquidity || market.liquidity || 0,
          odds: liveData?.odds || market.odds || null,
          outcomeMints: {
            yes: mints.yesMint,
            no: mints.noMint
          },
          liveData: liveData
        });
      }
    }

    return {
      symbol,
      ticker,
      events: events.map(e => ({
        id: e.id || e.eventId,
        title: e.title || e.name,
        expiry: e.expiry || e.expiryTime,
        status: e.status,
        description: e.description
      })),
      markets: marketsWithData,
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error(`[dFlow] Error fetching prediction markets for ${symbol}:`, error.message);
    return {
      symbol,
      ticker,
      error: error.message,
      events: [],
      markets: []
    };
  }
}

/**
 * Get series/ticker information
 * @param {string} ticker - Ticker symbol (e.g., 'BTC')
 * @returns {Promise<Object>} Series data
 */
export async function getSeriesByTicker(ticker) {
  const cacheKey = `series_${ticker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(`${DFLOw_METADATA_URL}/series`, {
      params: {
        ticker: ticker
      },
      timeout: 10000
    });

    const series = response.data || {};
    setCache(cacheKey, series);
    return series;
  } catch (error) {
    console.error(`[dFlow] Error fetching series for ${ticker}:`, error.message);
    return null;
  }
}

export default {
  searchEvents,
  getMarketsByEvent,
  getOutcomeMints,
  getLiveData,
  getPredictionMarkets,
  getSeriesByTicker
};

