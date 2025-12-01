/**
 * Vercel Serverless Function: Full Strategy Analysis Endpoint
 * GET /api/analyze-full?symbol=BTCUSDT&mode=STANDARD
 * 
 * Returns rich strategy object with ALL strategies (even NO_TRADE ones)
 * Includes htfBias, timeframes, and all strategy evaluations
 */

import * as marketData from '../services/marketData.js';
import * as indicatorService from '../services/indicators.js';
import strategyService from '../services/strategy.js';

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
    
    // Parse intervals
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
    const currentPrice = parseFloat(ticker.price.toFixed(2));

    // Evaluate all strategies
    const allStrategiesResult = strategyService.evaluateAllStrategies(symbol, analysis, mode);
    
    // Build timeframe summary
    const timeframes = strategyService.buildTimeframeSummary(analysis);
    
    // Get HTF bias from strategy service (compute from analysis directly)
    // Use the exported computeHTFBias function
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
      strategies: {
        SWING: allStrategiesResult.strategies.SWING,
        TREND_4H: allStrategiesResult.strategies.TREND_4H,
        SCALP_1H: allStrategiesResult.strategies.SCALP_1H,
        MICRO_SCALP: allStrategiesResult.strategies.MICRO_SCALP
      },
      bestSignal: allStrategiesResult.bestSignal,
      schemaVersion: '1.0.0',
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
}

