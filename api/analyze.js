/**
 * Vercel Serverless Function: Strategy Analysis Endpoint
 * GET /api/analyze?symbol=BTCUSDT&intervals=4h,1h,15m,5m
 * 
 * Returns complete 4H strategy analysis with trade signal
 */

import * as marketData from '../services/marketData.js';
import * as indicatorService from '../services/indicators.js';
import strategyService from '../services/strategy.js';
import * as candleFeatures from '../lib/candleFeatures.js';
import * as levels from '../lib/levels.js';
import * as advancedIndicators from '../lib/advancedIndicators.js';
import * as volumeAnalysis from '../lib/volumeAnalysis.js';
import * as confluenceScoring from '../lib/confluenceScoring.js';

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse symbol from URL path or query parameter
    // Supports both /api/analyze/BTCUSDT and /api/analyze?symbol=BTCUSDT
    let symbol = req.query.symbol;
    
    // Try to extract from URL path if not in query
    if (!symbol && req.url) {
      const pathMatch = req.url.match(/\/api\/analyze\/([^?]+)/);
      if (pathMatch) {
        symbol = pathMatch[1];
      }
    }

    // Validate required parameters
    if (!symbol) {
      return res.status(400).json({ 
        error: 'Missing required parameter: symbol',
        examples: [
          '/api/analyze/BTCUSDT',
          '/api/analyze?symbol=BTCUSDT&intervals=4h,1h,15m,5m'
        ]
      });
    }
    
    // Parse intervals from query
    const { intervals } = req.query;

    // Parse intervals (default to strategy requirements - now includes 3D, 1w, 1M for swing trades and 3m for micro structure)
    const intervalList = intervals 
      ? intervals.split(',').map(i => i.trim()) 
      : ['1M', '1w', '3d', '1d', '4h', '1h', '15m', '5m', '3m', '1m'];

    console.log(`[Analyze] Processing ${symbol} for intervals: ${intervalList.join(', ')}`);

    // Fetch multi-timeframe OHLCV data
    const multiData = await marketData.getMultiTimeframeData(symbol, intervalList, 500);

    // Calculate indicators for each timeframe
    const analysis = {};
    for (const [interval, candles] of Object.entries(multiData)) {
      // Check for errors
      if (candles && candles.error) {
        analysis[interval] = { error: candles.error };
        console.log(`[Analyze] ❌ ${interval}: ${candles.error}`);
        continue;
      }

      // Validate data
      if (!Array.isArray(candles) || candles.length === 0) {
        analysis[interval] = { error: 'No data' };
        console.log(`[Analyze] ❌ ${interval}: No data`);
        continue;
      }

      try {
        // Calculate indicators and structure
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles, 20);
        
        // Get last 2 candles for enriched analysis
        const latestCandle = candles[candles.length - 1];
        const previousCandle = candles[candles.length - 2];
        
        // Describe current candle
        const candleDesc = candleFeatures.describeCandle(latestCandle, indicators.ema.ema21);
        
        // Detect price action patterns
        const priceAction = candleFeatures.detectPriceAction(latestCandle, previousCandle);
        
        // Compute support/resistance levels (for 4h and 1h only)
        const shouldComputeLevels = ['4h', '1h'].includes(interval);
        const levelsData = shouldComputeLevels ? 
          levels.computeLevels(candles, indicators.price.current, swingPoints) : null;
        
        // Get recent candles for trigger timeframe (5m)
        const recentCandles = (interval === '5m') ? 
          candleFeatures.getRecentCandles(candles, 5) : null;
        
        // Calculate advanced indicators (VWAP, ATR, Bollinger, MA Stack)
        const advancedData = advancedIndicators.calculateAllAdvanced(
          candles,
          indicators.price.current,
          indicators.analysis.trend,
          { ema21: indicators.ema.ema21, ema200: indicators.ema.ema200 },
          interval
        );
        
        // Calculate volume analysis
        const volumeData = volumeAnalysis.calculateVolumeAnalysis(candles);
        
        // Build complete timeframe data (for confluence calculation)
        const tfData = {
          trend: indicators.analysis.trend,
          ema21: indicators.ema.ema21,
          ema200: indicators.ema.ema200,
          candle: candleDesc,
          priceAction: priceAction,
          pullback: {
            state: indicators.analysis.pullbackState,
            distanceFrom21EMA: indicators.analysis.distanceFrom21EMA
          },
          stoch: indicators.stochRSI,
          ...advancedData
        };
        
        // Calculate confluence scores
        const confluenceScores = confluenceScoring.calculateConfluence(tfData);
        
        analysis[interval] = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1],
          
          // Enhanced candle analysis
          candle: candleDesc,
          priceAction: priceAction,
          
          // Support/resistance levels (4h and 1h only)
          ...(levelsData && { levels: levelsData }),
          
          // Recent candles for LLM context (5m only)
          ...(recentCandles && { recentCandles: recentCandles }),
          
          // Advanced indicators (VWAP, ATR, Bollinger, MA Stack)
          ...advancedData,
          
          // Volume analysis (if available)
          ...(volumeData && { volume: volumeData }),
          
          // Confluence scoring
          confluence: confluenceScores
        };
        
        console.log(`[Analyze] ✅ ${interval}: ${indicators.analysis.trend}`);
      } catch (err) {
        analysis[interval] = { error: err.message };
        console.error(`[Analyze] ❌ ${interval}: ${err.message}`);
      }
    }

    // Get current price
    console.log(`[Analyze] Fetching current price for ${symbol}...`);
    const ticker = await marketData.getTickerPrice(symbol);

    // Get setupType from query (default to 'auto' to check all strategies)
    const setupType = req.query.setupType || 'auto';
    console.log(`[Analyze] Setup type: ${setupType}`);
    
    // Get mode from query (default to 'STANDARD')
    const mode = req.query.mode || 'STANDARD';
    console.log(`[Analyze] Mode: ${mode}`);

    // Run strategy evaluation (will check Swing first, then 4H/Scalp)
    console.log(`[Analyze] Running strategy evaluation (${setupType}, mode: ${mode})...`);
    const canonicalResult = strategyService.evaluateStrategy(symbol, analysis, setupType, mode);

    // Evaluate Micro-Scalp Override (only relevant when 4H is FLAT and normal trade blocked)
    console.log(`[Analyze] Evaluating micro-scalp override...`);
    const microScalpResult = strategyService.evaluateMicroScalp(analysis);

    // Canonical result already has the structure: { symbol, price, htfBias, timeframes, signal, meta }
    // Build response with canonical structure + backward compatibility fields
    const response = {
      // Canonical structure
      ...canonicalResult,
      price: canonicalResult.price || parseFloat(ticker.price.toFixed(2)),
      
      // Backward compatibility - keep old field names
      currentPrice: canonicalResult.price || parseFloat(ticker.price.toFixed(2)),
      priceChange24h: parseFloat(ticker.priceChangePercent.toFixed(2)),
      
      // Signal aliases for backward compatibility
      signal: canonicalResult.signal,
      tradeSignal: canonicalResult.signal,  // Alias for backward compatibility
      
      // Full analysis object (for detailed UI)
      analysis,
      
      // Micro-scalp info
      microScalpEligible: microScalpResult.eligible,
      microScalp: microScalpResult.signal,
      
      timestamp: new Date().toISOString()
    };

    // Return the response (already in correct format for frontend)
    return res.status(200).json(response);

  } catch (error) {
    console.error('[Analyze] Error:', error.message);
    console.error('[Analyze] Stack:', error.stack);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

