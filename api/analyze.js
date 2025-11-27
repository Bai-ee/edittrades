/**
 * Vercel Serverless Function: Strategy Analysis Endpoint
 * GET /api/analyze?symbol=BTCUSDT&intervals=4h,1h,15m,5m
 * 
 * Returns complete 4H strategy analysis with trade signal
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

    // Parse intervals (default to strategy requirements)
    const intervalList = intervals 
      ? intervals.split(',').map(i => i.trim()) 
      : ['4h', '1h', '15m', '5m'];

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
        
        analysis[interval] = {
          indicators,
          structure: swingPoints,
          candleCount: candles.length,
          lastCandle: candles[candles.length - 1]
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

    // Run strategy evaluation
    console.log(`[Analyze] Running 4H strategy evaluation...`);
    const tradeSignal = strategyService.evaluateStrategy(symbol, analysis);

    // Build clean response for API
    const response = {
      symbol,
      direction: tradeSignal.direction.toUpperCase(),
      reason: tradeSignal.reason_summary || tradeSignal.reason || 'No setup detected',
      valid: tradeSignal.valid,
      confidence: parseFloat((tradeSignal.confidence || 0).toFixed(2)),
      currentPrice: parseFloat(ticker.price.toFixed(2)),
      priceChange24h: parseFloat(ticker.priceChangePercent.toFixed(2)),
      timestamp: new Date().toISOString()
    };

    // Add trade levels if valid signal
    if (tradeSignal.valid && tradeSignal.direction !== 'flat') {
      response.entryZone = {
        min: parseFloat(tradeSignal.entry_zone.min.toFixed(2)),
        max: parseFloat(tradeSignal.entry_zone.max.toFixed(2))
      };
      response.stopLoss = parseFloat(tradeSignal.stop_loss.toFixed(2));
      response.targets = {
        tp1: parseFloat(tradeSignal.targets[0].toFixed(2)),
        tp2: parseFloat(tradeSignal.targets[1].toFixed(2))
      };

      // Calculate risk/reward ratios
      const entryMid = (response.entryZone.min + response.entryZone.max) / 2;
      const risk = Math.abs(entryMid - response.stopLoss);
      const reward1 = Math.abs(response.targets.tp1 - entryMid);
      const reward2 = Math.abs(response.targets.tp2 - entryMid);
      
      response.riskReward = {
        tp1RR: parseFloat((reward1 / risk).toFixed(2)),
        tp2RR: parseFloat((reward2 / risk).toFixed(2))
      };

      // Add current levels
      response.levels = {
        ema21: tradeSignal.ema21 ? parseFloat(tradeSignal.ema21.toFixed(2)) : null,
        ema200: tradeSignal.ema200 ? parseFloat(tradeSignal.ema200.toFixed(2)) : null
      };
    }

    // Add timeframe trends
    response.timeframes = {};
    for (const [interval, data] of Object.entries(analysis)) {
      if (data.error) {
        response.timeframes[interval] = { error: data.error };
      } else {
        response.timeframes[interval] = {
          trend: data.indicators.analysis.trend,
          stoch: {
            k: data.indicators.stochRSI.k ? parseFloat(data.indicators.stochRSI.k.toFixed(2)) : null,
            d: data.indicators.stochRSI.d ? parseFloat(data.indicators.stochRSI.d.toFixed(2)) : null,
            condition: data.indicators.stochRSI.condition
          },
          pullbackState: data.indicators.analysis.pullbackState
        };
      }
    }

    // Log result
    console.log(`[Analyze] Signal: ${response.direction} @ ${response.confidence} confidence`);

    return res.status(200).json(response);

  } catch (error) {
    console.error('[Analyze] Error:', error.message);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

