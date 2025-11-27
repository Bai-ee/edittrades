/**
 * Snapshot TradingView Server
 * Express server that provides REST API for crypto data and indicators
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import * as binanceService from './services/binance.js';
import * as coingeckoService from './services/coingecko.js';
import * as indicatorService from './services/indicators.js';
import * as strategyService from './services/strategy.js';
import * as marketData from './services/marketData.js';
import * as scannerService from './services/scanner.js';

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
app.use(express.json());
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

    // Run strategy evaluation (strategy.js remains unchanged)
    console.log(`\n🎯 Running strategy evaluation...`);
    const tradeSignal = strategyService.evaluateStrategy(symbol, analysis);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 TRADE SIGNAL: ${tradeSignal.direction.toUpperCase()}`);
    if (tradeSignal.valid) {
      console.log(`   Entry: $${tradeSignal.entry_zone.min} - $${tradeSignal.entry_zone.max}`);
      console.log(`   SL: $${tradeSignal.stop_loss}`);
      console.log(`   TP1: $${tradeSignal.targets[0]} | TP2: $${tradeSignal.targets[1]}`);
      console.log(`   Confidence: ${(tradeSignal.confidence * 100).toFixed(0)}%`);
    } else {
      console.log(`   Reason: ${tradeSignal.reason}`);
    }
    console.log(`${'='.repeat(60)}\n`);

    res.json({
      symbol,
      currentPrice: ticker.price,
      priceChange24h: ticker.priceChangePercent,
      analysis,
      tradeSignal,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('\n❌ ERROR in /api/analyze:', error.message);
    console.error(error.stack);
    res.status(500).json({ error: error.message });
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

  console.log('\n💾 Data Source: Auto-detect (Binance or CoinGecko)');
  console.log('\n✨ Ready to analyze crypto markets!\n');
});

export default app;

