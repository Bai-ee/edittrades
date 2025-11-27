/**
 * Market Scanner Service
 * Scans all supported coins and identifies trading opportunities
 * Filters trades based on confidence and strategy requirements
 */

import * as marketData from './marketData.js';
import * as indicatorService from './indicators.js';
import * as strategyService from './strategy.js';

/**
 * Scan a single symbol for trading opportunities
 * @param {string} symbol - Trading pair (e.g., 'BTCUSDT')
 * @param {Array<string>} intervals - Timeframes to analyze
 * @returns {Promise<Object>} Trade signal or null if no valid setup
 */
async function scanSymbol(symbol, intervals = ['4h', '1h', '15m', '5m']) {
  try {
    console.log(`🔍 Scanning ${symbol}...`);
    
    // Fetch multi-timeframe data
    const multiData = await marketData.getMultiTimeframeData(symbol, intervals, 500);
    
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
        
        analysis[interval] = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1]
        };
      } catch (err) {
        analysis[interval] = { error: err.message };
      }
    }
    
    // Get current price
    const ticker = await marketData.getTickerPrice(symbol);
    
    // Run strategy evaluation
    const tradeSignal = strategyService.evaluateStrategy(symbol, analysis);
    
    // Add additional metadata
    return {
      ...tradeSignal,
      currentPrice: ticker.price,
      priceChange24h: ticker.priceChangePercent,
      volume24h: ticker.volume24h,
      scanTime: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`❌ Error scanning ${symbol}:`, error.message);
    return {
      symbol,
      error: error.message,
      valid: false
    };
  }
}

/**
 * Scan all supported symbols for trading opportunities
 * @param {Object} options - Scanner options
 * @returns {Promise<Object>} Scanner results with filtered opportunities
 */
export async function scanAllCoins(options = {}) {
  const {
    minConfidence = 0.5,  // Minimum confidence score (0-1)
    maxResults = 50,      // Maximum results to return
    intervals = ['4h', '1h', '15m', '5m'],
    useAllKrakenPairs = false  // If true, scan ALL Kraken pairs dynamically
  } = options;
  
  console.log('\n' + '='.repeat(60));
  console.log('🔍 MARKET SCANNER STARTING');
  console.log('='.repeat(60));
  console.log(`   Min Confidence: ${(minConfidence * 100).toFixed(0)}%`);
  console.log(`   Max Results: ${maxResults}`);
  console.log(`   Intervals: ${intervals.join(', ')}`);
  console.log('='.repeat(60) + '\n');
  
  // Get list of symbols to scan
  let symbolList;
  if (useAllKrakenPairs) {
    console.log('📥 Fetching ALL Kraken pairs...');
    const allPairs = await marketData.getAllKrakenPairs();
    symbolList = allPairs.map(p => p.symbol);
  } else {
    symbolList = marketData.getSupportedSymbols();
  }
  
  console.log(`📊 Scanning ${symbolList.length} symbols...\n`);
  
  const startTime = Date.now();
  const results = {
    opportunities: [],
    scanned: 0,
    errors: 0,
    noSetup: 0,
    lowConfidence: 0
  };
  
  // Scan symbols in batches to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < symbolList.length; i += batchSize) {
    const batch = symbolList.slice(i, i + batchSize);
    
    // Scan batch in parallel
    const batchResults = await Promise.all(
      batch.map(symbol => scanSymbol(symbol, intervals))
    );
    
    // Process results
    for (const signal of batchResults) {
      results.scanned++;
      
      if (signal.error) {
        results.errors++;
        continue;
      }
      
      if (!signal.valid) {
        results.noSetup++;
        continue;
      }
      
      if (signal.confidence < minConfidence) {
        results.lowConfidence++;
        continue;
      }
      
      // Valid opportunity found!
      results.opportunities.push(signal);
      console.log(`✅ ${signal.symbol}: ${signal.direction.toUpperCase()} @ ${signal.confidence.toFixed(2)} confidence`);
    }
    
    // Progress indicator
    const progress = Math.min(i + batchSize, symbolList.length);
    console.log(`   Progress: ${progress}/${symbolList.length} (${((progress/symbolList.length)*100).toFixed(0)}%)`);
    
    // Small delay between batches to avoid rate limiting
    if (i + batchSize < symbolList.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  // Sort opportunities by confidence (highest first)
  results.opportunities.sort((a, b) => b.confidence - a.confidence);
  
  // Limit results
  if (results.opportunities.length > maxResults) {
    results.opportunities = results.opportunities.slice(0, maxResults);
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ SCAN COMPLETE');
  console.log('='.repeat(60));
  console.log(`   Duration: ${duration}s`);
  console.log(`   Scanned: ${results.scanned} symbols`);
  console.log(`   Found: ${results.opportunities.length} opportunities`);
  console.log(`   Errors: ${results.errors}`);
  console.log(`   No Setup: ${results.noSetup}`);
  console.log(`   Low Confidence: ${results.lowConfidence}`);
  console.log('='.repeat(60) + '\n');
  
  return {
    summary: {
      totalScanned: results.scanned,
      opportunitiesFound: results.opportunities.length,
      errors: results.errors,
      noSetup: results.noSetup,
      lowConfidence: results.lowConfidence,
      duration: parseFloat(duration),
      timestamp: new Date().toISOString(),
      filters: {
        minConfidence,
        maxResults,
        intervals
      }
    },
    opportunities: results.opportunities
  };
}

/**
 * Filter opportunities by specific criteria
 * @param {Array} opportunities - Array of trade signals
 * @param {Object} filters - Filter criteria
 * @returns {Array} Filtered opportunities
 */
export function filterOpportunities(opportunities, filters = {}) {
  let filtered = [...opportunities];
  
  // Filter by direction
  if (filters.direction) {
    filtered = filtered.filter(opp => 
      opp.direction === filters.direction.toLowerCase()
    );
  }
  
  // Filter by minimum confidence
  if (filters.minConfidence) {
    filtered = filtered.filter(opp => 
      opp.confidence >= filters.minConfidence
    );
  }
  
  // Filter by specific symbols
  if (filters.symbols && Array.isArray(filters.symbols)) {
    filtered = filtered.filter(opp => 
      filters.symbols.includes(opp.symbol)
    );
  }
  
  // Filter by price range
  if (filters.minPrice) {
    filtered = filtered.filter(opp => 
      opp.currentPrice >= filters.minPrice
    );
  }
  
  if (filters.maxPrice) {
    filtered = filtered.filter(opp => 
      opp.currentPrice <= filters.maxPrice
    );
  }
  
  return filtered;
}

/**
 * Get top N opportunities
 * @param {number} count - Number of top opportunities to return
 * @param {Object} options - Scanner options
 * @returns {Promise<Array>} Top opportunities
 */
export async function getTopOpportunities(count = 10, options = {}) {
  const scanResults = await scanAllCoins({ ...options, maxResults: count });
  return scanResults.opportunities.slice(0, count);
}

export default {
  scanAllCoins,
  scanSymbol,
  filterOpportunities,
  getTopOpportunities
};

