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
    const tradeSignal = strategyService.evaluateStrategy(symbol, analysis);

    // Build COMPACT response - only essential trading info
    const compactResponse = {
      symbol,
      price: parseFloat(ticker.price.toFixed(2)),
      change24h: parseFloat(ticker.priceChangePercent.toFixed(2)),
      
      // Trade signal (most important!)
      signal: {
        valid: tradeSignal.valid,
        direction: tradeSignal.direction || 'NO_TRADE', // long | short | NO_TRADE
        confidence: tradeSignal.confidence ? parseFloat((tradeSignal.confidence * 100).toFixed(0)) : 0,
        reason: tradeSignal.reason_summary || tradeSignal.reason || 'Waiting for setup',
        
        // Only include trade levels if valid signal
        ...(tradeSignal.valid && {
          entry: {
            min: tradeSignal.entry_zone.min,
            max: tradeSignal.entry_zone.max
          },
          stopLoss: tradeSignal.stop_loss,
          targets: {
            tp1: tradeSignal.targets[0],
            tp2: tradeSignal.targets[1]
          },
          riskReward: `1:${((Math.abs(tradeSignal.targets[1] - ((tradeSignal.entry_zone.min + tradeSignal.entry_zone.max) / 2)) / Math.abs(((tradeSignal.entry_zone.min + tradeSignal.entry_zone.max) / 2) - tradeSignal.stop_loss))).toFixed(2)}`
        })
      },
      
      // Key timeframe info (only 4h and 1h for brevity)
      timeframes: {
        '4h': analysis['4h'] ? {
          trend: analysis['4h'].indicators.analysis.trend,
          ema21: parseFloat(analysis['4h'].indicators.ema.ema21.toFixed(2)),
          ema200: analysis['4h'].indicators.ema.ema200 ? parseFloat(analysis['4h'].indicators.ema.ema200.toFixed(2)) : null,
          stoch: {
            zone: analysis['4h'].indicators.stochRSI.condition,
            k: parseFloat(analysis['4h'].indicators.stochRSI.k.toFixed(1)),
            d: parseFloat(analysis['4h'].indicators.stochRSI.d.toFixed(1))
          },
          pullback: analysis['4h'].indicators.analysis.pullbackState,
          swingHigh: analysis['4h'].structure.swingHigh ? parseFloat(analysis['4h'].structure.swingHigh.toFixed(2)) : null,
          swingLow: analysis['4h'].structure.swingLow ? parseFloat(analysis['4h'].structure.swingLow.toFixed(2)) : null
        } : { error: 'No data' },
        
        '1h': analysis['1h'] ? {
          trend: analysis['1h'].indicators.analysis.trend,
          ema21: parseFloat(analysis['1h'].indicators.ema.ema21.toFixed(2)),
          stoch: {
            zone: analysis['1h'].indicators.stochRSI.condition,
            k: parseFloat(analysis['1h'].indicators.stochRSI.k.toFixed(1))
          },
          pullback: analysis['1h'].indicators.analysis.pullbackState
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

