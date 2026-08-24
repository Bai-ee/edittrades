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
// The macro timeframes are NOT optional.
//
// Confidence weights the macro layer at 40%, and a layer with no data forfeits
// its weight rather than scoring as if it agreed. Scanning on 4h/1h/15m/5m
// alone therefore caps a STANDARD signal at 60% of its table value — below
// every strategy's own admission gate — so the scan returns nothing at all.
// Verified: 0 valid signals without 1d/3d, 3 with them.
//
// 3d is aggregated from the same daily series (see services/marketData.js), so
// the pair costs one extra provider round trip rather than two.
const DEFAULT_SCAN_INTERVALS = ['3d', '1d', '4h', '1h', '15m', '5m'];

async function scanSymbol(symbol, intervals = DEFAULT_SCAN_INTERVALS) {
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
    
    // Run strategy evaluation (returns canonical structure)
    const canonicalResult = strategyService.evaluateStrategy(symbol, analysis, 'auto', 'STANDARD');
    
    // Canonical result already has: { symbol, price, htfBias, timeframes, signal, meta }
    // Add scanner-specific metadata to meta object
    const enhancedMeta = {
      ...canonicalResult.meta,
      scanTime: new Date().toISOString(),
      volume24h: ticker.volume24h,
      priceChange24h: ticker.priceChangePercent
    };
    
    // Return canonical structure with enhanced metadata
    return {
      ...canonicalResult,
      price: ticker.price,
      meta: enhancedMeta,
      // Backward compatibility fields
      currentPrice: ticker.price,
      priceChange24h: ticker.priceChangePercent,
      volume24h: ticker.volume24h
    };
    
  } catch (error) {
    console.error(`❌ Error scanning ${symbol}:`, error.message);
    // Return canonical structure even for errors
    return {
      symbol,
      price: null,
      htfBias: { direction: 'neutral', confidence: 0, source: 'none' },
      timeframes: {},
      signal: {
        valid: false,
        direction: 'NO_TRADE',
        setupType: 'auto',
        selectedStrategy: 'NO_TRADE',
        strategiesChecked: [],
        confidence: 0,
        reason: `Error: ${error.message}`,
        entryZone: { min: null, max: null },
        stopLoss: null,
        invalidationLevel: null,
        targets: [null, null],
        riskReward: { tp1RR: null, tp2RR: null }
      },
      meta: {
        scanTime: new Date().toISOString(),
        mode: 'STANDARD',
        error: error.message
      }
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
    // Confidence is on a 0-100 scale everywhere in the engine. This default
    // was 0.5 and was compared directly against it, so the filter never
    // rejected a single signal — it read as a safety control and was inert.
    minConfidence = 50,   // Minimum confidence score (0-100)
    maxResults = 50,      // Maximum results to return
    intervals = DEFAULT_SCAN_INTERVALS,
    useAllKrakenPairs = false  // If true, scan ALL Kraken pairs dynamically
  } = options;
  
  console.log('\n' + '='.repeat(60));
  console.log('🔍 MARKET SCANNER STARTING');
  console.log('='.repeat(60));
  console.log(`   Min Confidence: ${minConfidence}%`);
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
    // `scanSymbol` returns the canonical shape { symbol, price, htfBias,
    // timeframes, signal, meta } — so the decision fields live under
    // `result.signal.*`. This loop read `result.valid` and `result.confidence`
    // directly, which were always `undefined`: `!undefined` is true, so EVERY
    // symbol was counted as noSetup and `opportunities` could never be
    // non-empty. The scanner reported a clean 200 with a plausible summary
    // while being structurally incapable of finding anything.
    for (const result of batchResults) {
      results.scanned++;

      if (result.error) {
        results.errors++;
        continue;
      }

      const signal = result.signal;
      if (!signal || !signal.valid) {
        results.noSetup++;
        continue;
      }

      if (!Number.isFinite(signal.confidence) || signal.confidence < minConfidence) {
        results.lowConfidence++;
        continue;
      }

      results.opportunities.push(result);
      console.log(
        `✅ ${result.symbol}: ${String(signal.direction).toUpperCase()} @ ${signal.confidence.toFixed(2)} confidence`
      );
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
  // Canonical shape: confidence lives on `.signal`, not the root.
  results.opportunities.sort((a, b) => (b.signal?.confidence ?? 0) - (a.signal?.confidence ?? 0));
  
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
      opp.signal?.direction?.toLowerCase() === filters.direction.toLowerCase()
    );
  }
  
  // Filter by minimum confidence
  if (filters.minConfidence) {
    filtered = filtered.filter(opp => 
      (opp.signal?.confidence ?? 0) >= filters.minConfidence
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
      (opp.price ?? opp.currentPrice) >= filters.minPrice
    );
  }
  
  if (filters.maxPrice) {
    filtered = filtered.filter(opp => 
      (opp.price ?? opp.currentPrice) <= filters.maxPrice
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

