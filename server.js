/**
 * Snapshot TradingView Server
 * Express server that provides REST API for crypto data and indicators
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import * as binanceService from './services/binance.js';
import * as coingeckoService from './services/coingecko.js';
import * as indicatorService from './services/indicators.js';
import * as strategyService from './services/strategy.js';
import * as marketData from './services/marketData.js';
import * as scannerService from './services/scanner.js';
import * as advancedChartAnalysis from './lib/advancedChartAnalysis.js';
import * as dataValidation from './lib/dataValidation.js';

// Use CoinGecko as fallback if Binance is geo-restricted (for old endpoints)
let dataService = binanceService;
let usingFallback = false;

// ES Module dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Increase payload size limit for AI agent requests (market data can be large)
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'Snapshot TradingView API'
  });
});

/**
 * GET /api/data/:symbol/:interval
 * Fetch OHLCV data with calculated indicators
 * Example: /api/data/BTCUSDT/4h
 */
app.get('/api/data/:symbol/:interval', async (req, res) => {
  try {
    const { symbol, interval } = req.params;
    const limit = parseInt(req.query.limit) || 500;

    // Validate inputs
    if (!symbol || !interval) {
      return res.status(400).json({ 
        error: 'Symbol and interval are required' 
      });
    }

    // Fetch data from primary service (with fallback)
    console.log(`Fetching ${symbol} ${interval} data...`);
    let candles;
    try {
      candles = await dataService.fetchKlines(symbol, interval, limit);
    } catch (error) {
      if (!usingFallback && error.message.includes('451')) {
        console.log('⚠️  Binance geo-restricted, switching to CoinGecko...');
        dataService = coingeckoService;
        usingFallback = true;
        candles = await dataService.fetchKlines(symbol, interval, limit);
      } else {
        throw error;
      }
    }

    // Calculate indicators
    console.log(`Calculating indicators for ${symbol} ${interval}...`);
    const indicators = indicatorService.calculateAllIndicators(candles);

    // Detect swing points
    const swingPoints = indicatorService.detectSwingPoints(candles);

    // Check last candle for rejection
    const lastCandle = candles[candles.length - 1];
    const wickRejection = indicatorService.detectWickRejection(lastCandle);

    res.json({
      symbol,
      interval,
      candles: candles.slice(-100), // Return last 100 candles for display
      indicators,
      structure: swingPoints,
      lastCandle: {
        ...lastCandle,
        wickRejection
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in /api/data:', error.message);
    res.status(500).json({ 
      error: error.message,
      symbol: req.params.symbol,
      interval: req.params.interval
    });
  }
});

/**
 * GET /api/ticker/:symbol
 * Get current spot price and 24h stats
 * Example: /api/ticker/BTCUSDT
 */
app.get('/api/ticker/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    let ticker;
    try {
      ticker = await dataService.fetchTickerPrice(symbol);
    } catch (error) {
      if (!usingFallback) {
        console.log('⚠️  Switching to CoinGecko for ticker...');
        dataService = coingeckoService;
        usingFallback = true;
        ticker = await dataService.fetchTickerPrice(symbol);
      } else {
        throw error;
      }
    }
    res.json(ticker);
  } catch (error) {
    console.error('Error in /api/ticker:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/multi/:symbol
 * Get multi-timeframe analysis for a symbol
 * Example: /api/multi/BTCUSDT
 */
app.get('/api/multi/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const intervals = req.query.intervals 
      ? req.query.intervals.split(',') 
      : ['4h', '1h', '15m', '5m'];

    console.log(`Fetching multi-timeframe data for ${symbol}:`, intervals);

    // Fetch all timeframes in parallel
    let multiData;
    try {
      multiData = await dataService.fetchMultiTimeframe(symbol, intervals);
    } catch (error) {
      if (!usingFallback) {
        console.log('⚠️  Switching to CoinGecko for multi-timeframe data...');
        dataService = coingeckoService;
        usingFallback = true;
        multiData = await dataService.fetchMultiTimeframe(symbol, intervals);
      } else {
        throw error;
      }
    }

    // Calculate indicators for each timeframe
    const analysis = {};
    for (const [interval, candles] of Object.entries(multiData)) {
      if (candles.error) {
        analysis[interval] = { error: candles.error };
        continue;
      }

      try {
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles);
        
        analysis[interval] = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length
        };
      } catch (err) {
        analysis[interval] = { error: err.message };
      }
    }

    // Get current price
    const ticker = await dataService.fetchTickerPrice(symbol);

    res.json({
      symbol,
      currentPrice: ticker.price,
      priceChange24h: ticker.priceChangePercent,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error in /api/multi:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/validate/:symbol
 * Validate if a symbol exists on Binance
 */
app.get('/api/validate/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const isValid = await binanceService.validateSymbol(symbol);
    res.json({ symbol, valid: isValid });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/symbols
 * Get list of all supported trading symbols with metadata
 * Optional: ?all=true to fetch ALL pairs from Kraken dynamically
 */
app.get('/api/symbols', async (req, res) => {
  try {
    const fetchAll = req.query.all === 'true';
    
    let symbols;
    if (fetchAll) {
      console.log('📥 Fetching ALL trading pairs from Kraken...');
      symbols = await marketData.getAllKrakenPairs();
    } else {
      symbols = marketData.getSupportedSymbolsWithInfo();
    }
    
    res.json({
      count: symbols.length,
      symbols,
      source: fetchAll ? 'kraken-dynamic' : 'hardcoded'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analyze/:symbol
 * Complete 4H strategy analysis with trade signal
 * This is the main endpoint for the "set and forget" system
 * Uses marketData module as single source of truth for OHLCV data
 * Example: /api/analyze/BTCUSDT?intervals=4h,1h,15m,5m
 */
app.get('/api/analyze/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const intervals = req.query.intervals 
      ? req.query.intervals.split(',') 
      : ['4h', '1h', '15m', '5m'];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 ANALYZE REQUEST: ${symbol}`);
    console.log(`   Intervals: ${intervals.join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);

    // Fetch multi-timeframe OHLCV data from marketData module
    const multiData = await marketData.getMultiTimeframeData(symbol, intervals, 500);

    // Calculate indicators for each timeframe
    const analysis = {};
    for (const [interval, candles] of Object.entries(multiData)) {
      // Check if this interval had an error
      if (candles && candles.error) {
        analysis[interval] = { error: candles.error };
        console.log(`❌ ${interval}: ${candles.error}`);
        continue;
      }

      // Check if candles is a valid array
      if (!Array.isArray(candles) || candles.length === 0) {
        analysis[interval] = { error: 'No candles data' };
        console.log(`❌ ${interval}: No data`);
        continue;
      }

      try {
        console.log(`📈 ${interval}: Processing ${candles.length} candles...`);
        
        // Calculate all indicators (strategy engine expects this format)
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles, 20);
        
        analysis[interval] = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1]
        };
        
        console.log(`✅ ${interval}: Indicators calculated`);
      } catch (err) {
        analysis[interval] = { error: err.message };
        console.error(`❌ ${interval}: Indicator calculation failed:`, err.message);
      }
    }

    // Get current price
    console.log(`\n💰 Fetching current price for ${symbol}...`);
    const ticker = await marketData.getTickerPrice(symbol);
    console.log(`✅ Price: $${ticker.price.toLocaleString()}`);

    // Get setupType and mode from query (default to 'auto' and 'STANDARD')
    const setupType = req.query.setupType || 'auto';
    const mode = req.query.mode || 'STANDARD';
    
    // Run strategy evaluation (strategy.js remains unchanged)
    console.log(`\n🎯 Running strategy evaluation (${setupType}, mode: ${mode})...`);
    const canonicalResult = strategyService.evaluateStrategy(symbol, analysis, setupType, mode);
    const tradeSignal = canonicalResult.signal; // Extract signal from canonical structure
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 TRADE SIGNAL: ${tradeSignal.direction.toUpperCase()}`);
    if (tradeSignal.valid) {
      console.log(`   Entry: $${tradeSignal.entryZone.min} - $${tradeSignal.entryZone.max}`);
      console.log(`   SL: $${tradeSignal.stopLoss}`);
      console.log(`   TP1: $${tradeSignal.targets[0]} | TP2: $${tradeSignal.targets[1]}`);
      console.log(`   Confidence: ${(tradeSignal.confidence * 100).toFixed(0)}%`);
    } else {
      console.log(`   Reason: ${tradeSignal.reason}`);
    }
    console.log(`${'='.repeat(60)}\n`);

    // Return canonical structure with backward compatibility
    res.json({
      ...canonicalResult,
      currentPrice: ticker.price,
      priceChange24h: ticker.priceChangePercent,
      analysis,
      tradeSignal, // Backward compatibility alias
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('\n❌ ERROR in /api/analyze:', error.message);
    console.error(error.stack);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/analyze-full
 * Full Strategy Analysis Endpoint (for local development)
 * Returns rich strategy object with ALL strategies (even NO_TRADE ones)
 * Includes htfBias, timeframes, and all strategy evaluations
 * Example: /api/analyze-full?symbol=BTCUSDT&mode=STANDARD
 */
app.get('/api/analyze-full', async (req, res) => {
  try {
    // Parse symbol from URL path or query parameter
    let symbol = req.query.symbol;
    
    if (!symbol && req.url) {
      const pathMatch = req.url.match(/\/api\/analyze-full\/([^?]+)/);
      if (pathMatch) {
        symbol = pathMatch[1];
      }
    }

    if (!symbol) {
      return res.status(400).json({ 
        error: 'Missing required parameter: symbol'
      });
    }
    
    // Get mode from query (default to 'STANDARD')
    const mode = req.query.mode || 'STANDARD';
    
    // Parse intervals (default includes all timeframes including 1M, 1w, 3m)
    const { intervals } = req.query;
    const intervalList = intervals 
      ? intervals.split(',').map(i => i.trim()) 
      : ['1M', '1w', '3d', '1d', '4h', '1h', '15m', '5m', '3m', '1m'];

    console.log(`[Analyze-Full] Processing ${symbol} (mode: ${mode}) for intervals: ${intervalList.join(', ')}`);

    // Fetch multi-timeframe OHLCV data
    const multiData = await marketData.getMultiTimeframeData(symbol, intervalList, 500);

    // Calculate indicators for each timeframe
    const analysis = {};
    for (const [interval, candles] of Object.entries(multiData)) {
      if (candles && candles.error) {
        analysis[interval] = { error: candles.error };
        continue;
      }

      if (!Array.isArray(candles) || candles.length === 0) {
        analysis[interval] = { error: 'No data' };
        continue;
      }

      try {
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles, 20);
        
        // Calculate advanced chart analysis modules
        const trend = indicators.analysis?.trend || 'FLAT';
        const advancedChart = advancedChartAnalysis.calculateAllAdvancedChartAnalysis(
          candles,
          indicators,
          swingPoints,
          trend
        );
        
        // Get volatility from advancedIndicators - Always include (even if null)
        let volatility = null;
        try {
          const { calculateATR } = await import('./lib/advancedIndicators.js');
          const atrData = calculateATR(candles);
          if (atrData) {
            // Ensure state is always set
            const state = (atrData.volatilityState || 'NORMAL').toLowerCase();
            volatility = {
              atr: atrData.atr,
              atrPctOfPrice: atrData.atrPct,
              state: ['low', 'normal', 'high', 'extreme'].includes(state) ? state : 'normal'
            };
          } else {
            volatility = {
              atr: null,
              atrPctOfPrice: null,
              state: 'normal' // Default state
            };
          }
        } catch (atrError) {
          console.warn(`[Server] ATR calculation error for ${interval}:`, atrError.message);
          volatility = {
            atr: null,
            atrPctOfPrice: null,
            state: 'normal' // Default state
          };
        }
        
        // Calculate volume metrics - Always include (even if null)
        let volume = null;
        try {
          const { calculateVolumeAnalysis } = await import('./lib/volumeAnalysis.js');
          volume = calculateVolumeAnalysis(candles, 20);
        } catch (volumeError) {
          console.warn(`[Server] Volume calculation error for ${interval}:`, volumeError.message);
          const lastCandle = candles[candles.length - 1];
          volume = lastCandle?.volume ? {
            current: lastCandle.volume,
            avg20: null,
            trend: null
          } : null;
        }
        
        // Build analysis object with advanced modules - ALWAYS include all fields (even if null/empty)
        const tfAnalysis = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1],
          // Advanced chart analysis modules - ALWAYS include structured objects (never null)
          marketStructure: advancedChart.marketStructure || {
            currentStructure: 'unknown',
            lastSwings: [],
            lastBos: { type: 'BOS', direction: 'neutral', fromSwing: null, toSwing: null, price: null, timestamp: null },
            lastChoch: { type: 'CHOCH', direction: 'neutral', fromSwing: null, toSwing: null, price: null, timestamp: null }
          },
          volatility: volatility || { atr: null, atrPctOfPrice: null, state: 'normal' }, // Always include
          volume: volume || null, // Volume metrics (current, avg20, trend)
          volumeProfile: advancedChart.volumeProfile || {
            highVolumeNodes: [],
            lowVolumeNodes: [],
            valueAreaHigh: null,
            valueAreaLow: null
          },
          liquidityZones: (advancedChart.liquidityZones !== undefined && Array.isArray(advancedChart.liquidityZones)) ? advancedChart.liquidityZones : [], // Always include array (never null)
          fairValueGaps: (advancedChart.fairValueGaps !== undefined && Array.isArray(advancedChart.fairValueGaps)) ? advancedChart.fairValueGaps : [], // Always include array (never null)
          divergences: (advancedChart.divergences !== undefined && Array.isArray(advancedChart.divergences)) ? advancedChart.divergences : [] // Always include array (never null)
        };

        // Validate and fix data consistency issues
        const currentPrice = indicators.price?.current || candles[candles.length - 1]?.close;
        analysis[interval] = dataValidation.validateTimeframeAnalysis(tfAnalysis, currentPrice);
      } catch (err) {
        // Even on error, include all required fields with defaults
        analysis[interval] = {
          error: err.message,
          indicators: null,
          structure: null,
          candleCount: 0,
          lastCandle: null,
          marketStructure: {
            currentStructure: 'unknown',
            lastSwings: [],
            lastBos: { type: 'BOS', direction: 'neutral', fromSwing: null, toSwing: null, price: null, timestamp: null },
            lastChoch: { type: 'CHOCH', direction: 'neutral', fromSwing: null, toSwing: null, price: null, timestamp: null }
          },
          volatility: { atr: null, atrPctOfPrice: null, state: 'normal' },
          volumeProfile: {
            highVolumeNodes: [],
            lowVolumeNodes: [],
            valueAreaHigh: null,
            valueAreaLow: null
          },
          liquidityZones: [], // Always include as array
          fairValueGaps: [], // Always include as array
          divergences: [] // Always include as array
        };
      }
    }

    // Get current price and market data
    const ticker = await marketData.getTickerPrice(symbol);
    const currentPrice = parseFloat(ticker.price.toFixed(2));
    
    // Fetch additional market data (spread, bid/ask, order book, recent trades)
    let marketDataInfo = null;
    try {
      const krakenSymbol = marketData.SYMBOL_MAP?.[symbol]?.kraken || 'XBTUSD';
      const tickerResponse = await axios.get('https://api.kraken.com/0/public/Ticker', {
        params: { pair: krakenSymbol },
        timeout: 5000
      });
      
      if (tickerResponse.data && !tickerResponse.data.error) {
        const pairKey = Object.keys(tickerResponse.data.result)[0];
        const tickerInfo = tickerResponse.data.result[pairKey];
        
        const bid = parseFloat(tickerInfo.b[0]) || currentPrice;
        const ask = parseFloat(tickerInfo.a[0]) || currentPrice;
        const bidQty = parseFloat(tickerInfo.b[2] || tickerInfo.b[3] || 0) || 0;
        const askQty = parseFloat(tickerInfo.a[2] || tickerInfo.a[3] || 0) || 0;
        const tradeCount24h = parseInt(tickerInfo.t[1] || tickerInfo.t[0] || 0) || 0;
        
        const spread = Math.abs(ask - bid);
        const spreadPercent = currentPrice > 0 ? (spread / currentPrice) * 100 : 0;
        const totalQty = bidQty + askQty;
        const bidAskImbalance = totalQty > 0 ? ((bidQty - askQty) / totalQty) * 100 : 0;
        const volumeQuality = tradeCount24h > 50000 ? 'HIGH' : tradeCount24h > 20000 ? 'MEDIUM' : 'LOW';
        
        let orderBookData = null;
        try {
          const orderBookResponse = await axios.get('https://api.kraken.com/0/public/Depth', {
            params: { pair: krakenSymbol, count: 10 },
            timeout: 5000
          });
          
          if (orderBookResponse.data && !orderBookResponse.data.error) {
            const orderBook = orderBookResponse.data.result[pairKey];
            const bids = orderBook.bids || [];
            const asks = orderBook.asks || [];
            
            const bidLiquidity = bids.reduce((sum, [price, qty]) => sum + parseFloat(qty), 0);
            const askLiquidity = asks.reduce((sum, [price, qty]) => sum + parseFloat(qty), 0);
            const totalLiquidity = bidLiquidity + askLiquidity;
            const liquidityImbalance = totalLiquidity > 0 ? ((bidLiquidity - askLiquidity) / totalLiquidity) * 100 : 0;
            
            orderBookData = {
              bidLiquidity: parseFloat(bidLiquidity.toFixed(3)),
              askLiquidity: parseFloat(askLiquidity.toFixed(2)),
              imbalance: parseFloat(liquidityImbalance.toFixed(1))
            };
          }
        } catch (obError) {
          console.warn(`[Analyze-Full] Order book unavailable for ${symbol}:`, obError.message);
        }
        
        let recentTradesData = null;
        try {
          const tradesResponse = await axios.get('https://api.kraken.com/0/public/Trades', {
            params: { pair: krakenSymbol, count: 100 },
            timeout: 5000
          });
          
          if (tradesResponse.data && !tradesResponse.data.error) {
            const trades = tradesResponse.data.result[pairKey] || [];
            let buyVolume = 0;
            let sellVolume = 0;
            
            trades.forEach(([price, volume, time, side]) => {
              const vol = parseFloat(volume);
              if (side === 'b' || side === 'buy') {
                buyVolume += vol;
              } else {
                sellVolume += vol;
              }
            });
            
            const totalVolume = buyVolume + sellVolume;
            const buyPressure = totalVolume > 0 ? (buyVolume / totalVolume) * 100 : 50;
            const sellPressure = totalVolume > 0 ? (sellVolume / totalVolume) * 100 : 50;
            const volumeImbalance = buyPressure - sellPressure;
            const overallFlow = volumeImbalance > 5 ? 'BUY' : volumeImbalance < -5 ? 'SELL' : 'NEUTRAL';
            
            recentTradesData = {
              overallFlow: overallFlow,
              buyPressure: parseFloat(buyPressure.toFixed(1)),
              sellPressure: parseFloat(sellPressure.toFixed(1)),
              volumeImbalance: parseFloat(volumeImbalance.toFixed(1))
            };
          }
        } catch (tradesError) {
          console.warn(`[Analyze-Full] Recent trades unavailable for ${symbol}:`, tradesError.message);
        }
        
        marketDataInfo = {
          spread: parseFloat(spread.toFixed(2)),
          spreadPercent: parseFloat(spreadPercent.toFixed(4)),
          bid: parseFloat(bid.toFixed(2)),
          ask: parseFloat(ask.toFixed(2)),
          bidAskImbalance: parseFloat(bidAskImbalance.toFixed(1)),
          volumeQuality: volumeQuality,
          tradeCount24h: tradeCount24h,
          orderBook: orderBookData,
          recentTrades: recentTradesData
        };
      }
    } catch (error) {
      console.warn(`[Analyze-Full] Market data unavailable for ${symbol}:`, error.message);
      marketDataInfo = null;
    }

    // Fetch dFlow prediction market data (non-blocking - don't fail if unavailable)
    let dflowData = null;
    try {
      dflowData = await marketData.getDflowPredictionMarkets(symbol);
    } catch (error) {
      console.warn(`[Analyze-Full] dFlow data unavailable for ${symbol}:`, error.message);
      dflowData = {
        symbol,
        error: 'dFlow API unavailable',
        events: [],
        markets: []
      };
    }

    // Evaluate all strategies (pass marketData and dflowData for filters)
    const allStrategiesResult = strategyService.evaluateAllStrategies(
      symbol, 
      analysis, 
      mode,
      marketDataInfo,  // Pass market data for volume quality and trade flow filters
      dflowData         // Pass dFlow data for alignment check
    );
    
    // Build timeframe summary
    const timeframes = strategyService.buildTimeframeSummary(analysis);
    
    // Get HTF bias from strategy service (compute from analysis directly)
    const htfBiasRaw = strategyService.computeHTFBias(analysis);
    const htfBias = {
      direction: htfBiasRaw.direction || 'neutral',
      confidence: typeof htfBiasRaw.confidence === 'number' 
        ? (htfBiasRaw.confidence > 1 ? htfBiasRaw.confidence : htfBiasRaw.confidence * 100)
        : 0,
      source: htfBiasRaw.source || 'none'
    };
    
    // Build rich symbol object
    const richSymbol = {
      symbol,
      mode: mode === 'STANDARD' ? 'SAFE' : 'AGGRESSIVE',
      currentPrice,
      htfBias: {
        direction: htfBias.direction || 'neutral',
        confidence: typeof htfBias.confidence === 'number' 
          ? (htfBias.confidence > 1 ? htfBias.confidence : htfBias.confidence * 100)
          : 0,
        source: htfBias.source || 'none'
      },
      timeframes,
      analysis: analysis || {}, // ✅ CRITICAL: Include full analysis object with all chart data
      strategies: { ...allStrategiesResult.strategies }, // ✅ Includes TREND_RIDER automatically
      bestSignal: allStrategiesResult.bestSignal,
      overrideUsed: allStrategiesResult?.overrideUsed || false, // NEW: Override flag
      overrideNotes: allStrategiesResult?.overrideNotes || [], // NEW: Override explanation
      marketData: marketDataInfo, // Spread, bid/ask, volume quality, order book, recent trades
      dflowData: dflowData, // Prediction market data
      schemaVersion: '1.0.0',
      jsonVersion: '0.06', // Incremented - now includes full analysis object
      generatedAt: new Date().toISOString()
    };

    return res.status(200).json(richSymbol);

  } catch (error) {
    console.error('[Analyze-Full] Error:', error.message);
    console.error('[Analyze-Full] Stack:', error.stack);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /api/scan
 * Scan all supported coins and return trading opportunities
 * Query params:
 *   - minConfidence: Minimum confidence score (0-1), default 0.5
 *   - maxResults: Maximum results to return, default 50
 *   - intervals: Comma-separated intervals, default '4h,1h,15m,5m'
 *   - direction: Filter by 'long' or 'short'
 *   - all: If 'true', scan ALL Kraken pairs instead of just supported ones
 * Example: /api/scan?minConfidence=0.6&maxResults=10&direction=long
 */
app.get('/api/scan', async (req, res) => {
  try {
    const minConfidence = parseFloat(req.query.minConfidence) || 0.5;
    const maxResults = parseInt(req.query.maxResults) || 50;
    const intervals = req.query.intervals 
      ? req.query.intervals.split(',') 
      : ['4h', '1h', '15m', '5m'];
    const direction = req.query.direction || null;
    const useAllKrakenPairs = req.query.all === 'true';

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 SCAN REQUEST`);
    console.log(`   Min Confidence: ${(minConfidence * 100).toFixed(0)}%`);
    console.log(`   Max Results: ${maxResults}`);
    console.log(`   Intervals: ${intervals.join(', ')}`);
    if (direction) console.log(`   Direction Filter: ${direction}`);
    if (useAllKrakenPairs) console.log(`   Scanning ALL Kraken pairs`);
    console.log(`${'='.repeat(60)}\n`);

    // Run the scanner
    const scanResults = await scannerService.scanAllCoins({
      minConfidence,
      maxResults,
      intervals,
      useAllKrakenPairs
    });

    // Apply direction filter if specified
    let opportunities = scanResults.opportunities;
    if (direction) {
      opportunities = scannerService.filterOpportunities(opportunities, { direction });
    }

    res.json({
      ...scanResults,
      opportunities,
      summary: {
        ...scanResults.summary,
        filteredCount: opportunities.length
      }
    });

  } catch (error) {
    console.error('\n❌ ERROR in /api/scan:', error.message);
    console.error(error.stack);
    res.status(500).json({ error: error.message });
  }
});

// Crypto News API - CryptoPanic integration
let newsCache = null;
let lastNewsFetch = 0;
const NEWS_CACHE_DURATION = 300000; // 5 minutes (300 seconds) - CryptoPanic has strict rate limits

const mockNews = [
  { title: "Bitcoin ETF sees record $1B inflows as institutional interest surges", url: "https://www.coindesk.com/markets/", source: "CoinDesk", currencies: ["BTC"] },
  { title: "Ethereum upgrade successfully deployed on mainnet", url: "https://www.theblock.co/", source: "The Block", currencies: ["ETH"] },
  { title: "Solana TVL hits new all-time high of $4.5B", url: "https://defillama.com/chain/Solana", source: "DeFi Llama", currencies: ["SOL"] },
  { title: "Federal Reserve signals potential rate cuts in Q2", url: "https://www.bloomberg.com/markets", source: "Bloomberg", currencies: ["BTC", "ETH"] },
  { title: "Major exchange announces support for Solana staking", url: "https://cryptoslate.com/", source: "CryptoSlate", currencies: ["SOL"] },
  { title: "Bitcoin breaks above key resistance level at $92K", url: "https://www.tradingview.com/markets/cryptocurrencies/", source: "TradingView", currencies: ["BTC"] }
];

app.get('/api/crypto-news', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached news if still fresh
    if (newsCache && (now - lastNewsFetch) < NEWS_CACHE_DURATION) {
      return res.json({
        success: true,
        cached: true,
        news: newsCache
      });
    }

    // Fetch from CryptoPanic
    const API_KEY = process.env.CRYPTOPANIC_API_KEY || '7762b2058d34382d241b7bc409130a4c07074441';
    const params = new URLSearchParams({
      auth_token: API_KEY,
      filter: 'hot',
      currencies: 'BTC,ETH,SOL'
    });

    const apiUrl = `https://cryptopanic.com/api/v1/posts/?${params}`;
    console.log('Fetching crypto news from CryptoPanic...');
    
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
      throw new Error(`CryptoPanic API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('CryptoPanic news received:', data.results ? data.results.length : 0, 'items');
    
    // Normalize to simple format
    const normalizedNews = (data.results || []).slice(0, 20).map(item => ({
      title: item.title,
      url: item.url,
      source: item.source?.title || 'Unknown',
      published: item.published_at,
      currencies: item.currencies?.map(c => c.code) || []
    }));

    // Update cache
    newsCache = normalizedNews.length > 0 ? normalizedNews : mockNews;
    lastNewsFetch = now;

    return res.json({
      success: true,
      cached: false,
      news: newsCache
    });

  } catch (error) {
    console.error('Crypto news API error:', error.message || error);
    
    // Return cached news if available, even if stale
    if (newsCache) {
      console.log('⚠️ Using stale cached news due to API error');
      return res.json({
        success: true,
        cached: true,
        fallback: true,
        news: newsCache
      });
    }

    // Fallback to mock data
    console.log('⚠️ Using mock news data (API rate limited or unavailable)');
    return res.json({
      success: true,
      mock: true,
      news: mockNews
    });
  }
});

// Parse Trade Image - OpenAI Vision Integration
app.post('/api/parse-trade-image', async (req, res) => {
  try {
    const { imageData } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: 'No image data provided' });
    }

    // Get OpenAI API key from environment variable
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ 
        success: false,
        error: 'OpenAI API key not configured for local development',
        data: null
      });
    }

    console.log('🖼️ Parsing trade image with OpenAI Vision...');

    // Call OpenAI Vision API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are a trading assistant. Analyze this trading screenshot and extract the following information:
                
- Symbol/Coin (e.g., BTC, ETH, SOL) - return as BTCUSDT, ETHUSDT, or SOLUSDT
- Direction (LONG or SHORT)
- Entry Price (numeric value)
- Stop Loss (numeric value)

Return ONLY a JSON object with these exact keys: symbol, direction, entry, stopLoss

If you cannot determine a value with confidence, use null for that field.

Example response format:
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "entry": 42000,
  "stopLoss": 41000
}

Be precise with numbers. Do not include any markdown formatting or explanation, just the raw JSON object.`
              },
              {
                type: 'image_url',
                image_url: {
                  url: imageData
                }
              }
            ]
          }
        ],
        max_tokens: 300,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI Vision API error:', response.status, errorText);
      throw new Error('OpenAI API request failed');
    }

    const result = await response.json();
    const content = result.choices[0]?.message?.content;
    
    if (!content) {
      throw new Error('No response from OpenAI');
    }

    console.log('📋 Raw response:', content);

    // Parse the JSON response
    let tradeData;
    try {
      const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      tradeData = JSON.parse(cleanContent);
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', content);
      throw new Error('Failed to parse trade data from image');
    }

    console.log('✅ Extracted trade data:', tradeData);

    return res.status(200).json({
      success: true,
      data: tradeData
    });

  } catch (error) {
    console.error('Error parsing trade image:', error);
    return res.status(500).json({ 
      error: 'Failed to analyze image',
      message: error.message 
    });
  }
});

// AI Agent Review - OpenAI Integration
app.post('/api/agent-review', async (req, res) => {
  try {
    const { marketSnapshot, setupType, symbol, tradesData, systemPrompt } = req.body;

    // MARKET REVIEW MODE (new)
    if (tradesData && systemPrompt) {
      console.log('📊 Market review mode detected');
      
      // Get OpenAI API key
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(200).json({ 
          success: true,
          review: 'Market analysis unavailable in local development without API key.',
          timestamp: new Date().toISOString()
        });
      }

      const userPrompt = `Analyze this market data and provide a concise 1-2 sentence market review:\n\n${JSON.stringify(tradesData, null, 2)}\n\nRemember: Keep it tight, observational, and focused on overall market behavior and correlation between assets.`;

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 150
        })
      });

      if (!response.ok) {
        console.error('OpenAI API error:', response.status);
        return res.status(response.status).json({ error: 'OpenAI API error' });
      }

      const data = await response.json();
      const review = data.choices[0]?.message?.content;

      if (!review) {
        return res.status(500).json({ error: 'No review from AI' });
      }

      console.log('✅ Market review received:', review);

      return res.json({
        success: true,
        review: review.trim(),
        timestamp: new Date().toISOString()
      });
    }

    // INDIVIDUAL TRADE ANALYSIS MODE (existing)
    if (!marketSnapshot || !setupType || !symbol) {
      return res.status(400).json({ 
        error: 'Missing required fields: marketSnapshot, setupType, symbol OR tradesData, systemPrompt' 
      });
    }

    // Get OpenAI API key from environment variable
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      // Return success with a placeholder response for local dev (no API key)
      // This prevents errors from showing in the UI
      return res.status(200).json({ 
        success: true,
        symbol,
        setupType,
        priority: 'A',
        formattedText: 'AI analysis unavailable in local development. Deploy to Vercel to enable OpenAI-powered trade analysis.',
        timestamp: new Date().toISOString(),
        localDev: true
      });
    }

    console.log(`🤖 AI analyzing ${symbol} ${setupType} setup...`);

    // Call OpenAI API (simplified version - full logic in api/agent-review.js)
    const tradeSystemPrompt = `You are a trading analysis AI. Analyze the ${setupType} setup for ${symbol} and provide a conversational assessment in 3-5 paragraphs. Rate it as A+, A, B, or SKIP.`;
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: tradeSystemPrompt },
          { role: 'user', content: `Analyze: ${JSON.stringify(marketSnapshot)}` }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', response.status, errorText);
      return res.status(response.status).json({ 
        error: `OpenAI API returned ${response.status}`,
        message: 'Check API key and OpenAI status'
      });
    }

    const data = await response.json();
    const agentResponse = data.choices[0]?.message?.content;

    if (!agentResponse) {
      return res.status(500).json({ error: 'No response from AI' });
    }

    // Parse priority rating
    let priority = 'A';
    if (agentResponse.includes('A+')) priority = 'A+';
    else if (agentResponse.includes('SKIP')) priority = 'SKIP';
    else if (agentResponse.includes('B')) priority = 'B';

    console.log(`✅ AI analysis complete for ${symbol} - Priority: ${priority}`);

    return res.json({
      success: true,
      symbol,
      setupType,
      priority,
      formattedText: agentResponse,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Agent review error:', error.message);
    return res.status(500).json({ 
      error: 'Agent review failed',
      message: error.message 
    });
  }
});

/**
 * POST /api/execute-trade
 * Execute a trade based on strategy signal
 * Body: { symbol, signal, tradeType, amount }
 */
app.post('/api/execute-trade', async (req, res) => {
  try {
    const { default: executeTradeHandler } = await import('./api/execute-trade.js');
    return executeTradeHandler(req, res);
  } catch (error) {
    console.error('Error loading execute-trade handler:', error);
    return res.status(500).json({ error: 'Failed to load trade execution handler' });
  }
});

/**
 * GET /api/trade-status/:signature
 * Check transaction status on Solana
 */
app.get('/api/trade-status/:signature', async (req, res) => {
  try {
    const { signature } = req.params;
    
    if (!signature) {
      return res.status(400).json({ error: 'Transaction signature is required' });
    }

    const { getTransactionStatus } = await import('./services/jupiterSwap.js');
    const status = await getTransactionStatus(signature);

    return res.json({
      success: true,
      signature,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error checking trade status:', error);
    return res.status(500).json({
      error: 'Failed to check transaction status',
      message: error.message,
    });
  }
});

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   Snapshot TradingView Server Running     ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`🔍 Health: http://localhost:${PORT}/health`);
  console.log('\n📡 API Endpoints:');
  console.log(`   GET /api/data/:symbol/:interval`);
  console.log(`   GET /api/ticker/:symbol`);
  console.log(`   GET /api/multi/:symbol`);
  console.log(`   GET /api/analyze/:symbol ⭐ (4H Strategy)`);
  console.log(`   GET /api/scan 🔍 (Market Scanner)`);
  console.log(`   POST /api/execute-trade 💰 (Jupiter Swap)`);
  console.log(`   GET /api/trade-status/:signature 📊 (Transaction Status)`);

  console.log('\n💾 Data Source: Auto-detect (Binance or CoinGecko)');
  console.log('\n✨ Ready to analyze crypto markets!\n');
});

export default app;

