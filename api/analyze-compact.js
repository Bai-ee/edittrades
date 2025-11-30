/**
 * Vercel Serverless Function: Compact Strategy Analysis for LLM
 * GET /api/analyze-compact/BTCUSDT
 * 
 * Returns streamlined analysis optimized for ChatGPT/LLM ingestion
 * Includes only essential trading information, removes verbose data
 */

import * as marketData from '../services/marketData.js';
import * as indicatorService from '../services/indicators.js';
import * as strategyService from '../services/strategy.js';

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
      const pathMatch = req.url.match(/\/api\/analyze-compact\/([^?]+)/);
      if (pathMatch) {
        symbol = pathMatch[1];
      }
    }

    if (!symbol) {
      return res.status(400).json({ 
        error: 'Missing required parameter: symbol',
        example: '/api/analyze-compact/BTCUSDT'
      });
    }
    
    const intervals = ['4h', '1h', '15m', '5m'];
    console.log(`[Compact] Processing ${symbol}`);

    // Fetch data and run analysis
    const multiData = await marketData.getMultiTimeframeData(symbol, intervals, 500);
    const analysis = {};
    
    for (const [interval, candles] of Object.entries(multiData)) {
      if (candles && !candles.error && Array.isArray(candles) && candles.length > 0) {
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles, 20);
        
        analysis[interval] = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1]
        };
      }
    }

    const ticker = await marketData.getTickerPrice(symbol);
    // Get canonical structure from evaluateStrategy
    const canonicalResult = strategyService.evaluateStrategy(symbol, analysis, 'auto', 'STANDARD');

    // Build COMPACT response - canonical structure but streamlined
    const compactResponse = {
      symbol: canonicalResult.symbol,
      price: canonicalResult.price || parseFloat(ticker.price.toFixed(2)),
      change24h: parseFloat(ticker.priceChangePercent.toFixed(2)),
      
      // HTF Bias
      htfBias: canonicalResult.htfBias,
      
      // Trade signal (from canonical structure)
      signal: {
        valid: canonicalResult.signal.valid,
        direction: canonicalResult.signal.direction,
        confidence: canonicalResult.signal.confidence ? parseFloat((canonicalResult.signal.confidence * 100).toFixed(0)) : 0,
        reason: canonicalResult.signal.reason,
        
        // Only include trade levels if valid signal
        ...(canonicalResult.signal.valid && {
          entry: canonicalResult.signal.entryZone,
          stopLoss: canonicalResult.signal.stopLoss,
          targets: {
            tp1: canonicalResult.signal.targets[0],
            tp2: canonicalResult.signal.targets[1]
          },
          riskReward: canonicalResult.signal.riskReward.tp2RR ? 
            `1:${canonicalResult.signal.riskReward.tp2RR.toFixed(2)}` : null
        })
      },
      
      // Key timeframe info (from canonical timeframes, only 4h and 1h for brevity)
      timeframes: {
        '4h': canonicalResult.timeframes['4h'] ? {
          trend: canonicalResult.timeframes['4h'].trend,
          ema21: canonicalResult.timeframes['4h'].ema21,
          ema200: canonicalResult.timeframes['4h'].ema200,
          stoch: canonicalResult.timeframes['4h'].stoch ? {
            zone: canonicalResult.timeframes['4h'].stoch.condition,
            k: parseFloat(canonicalResult.timeframes['4h'].stoch.k.toFixed(1)),
            d: parseFloat(canonicalResult.timeframes['4h'].stoch.d.toFixed(1))
          } : null,
          pullback: canonicalResult.timeframes['4h'].pullback?.state,
          swingHigh: canonicalResult.timeframes['4h'].structure?.swingHigh,
          swingLow: canonicalResult.timeframes['4h'].structure?.swingLow
        } : { error: 'No data' },
        
        '1h': canonicalResult.timeframes['1h'] ? {
          trend: canonicalResult.timeframes['1h'].trend,
          ema21: canonicalResult.timeframes['1h'].ema21,
          stoch: canonicalResult.timeframes['1h'].stoch ? {
            zone: canonicalResult.timeframes['1h'].stoch.condition,
            k: parseFloat(canonicalResult.timeframes['1h'].stoch.k.toFixed(1))
          } : null,
          pullback: canonicalResult.timeframes['1h'].pullback?.state
        } : { error: 'No data' }
      },
      
      timestamp: new Date().toISOString()
    };

    return res.status(200).json(compactResponse);

  } catch (error) {
    console.error('[Compact] Error:', error.message);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

