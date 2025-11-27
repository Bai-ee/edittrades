/**
 * Vercel Serverless Function: Indicators Endpoint
 * GET /api/indicators?symbol=BTCUSDT&intervals=4h,1h,15m,5m
 * 
 * Returns multi-timeframe indicator data for a given symbol
 */

import * as marketData from '../services/marketData.js';
import * as indicatorService from '../services/indicators.js';

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
    // Supports both /api/indicators/BTCUSDT and /api/indicators?symbol=BTCUSDT
    let symbol = req.query.symbol;
    
    // Try to extract from URL path if not in query
    if (!symbol && req.url) {
      const pathMatch = req.url.match(/\/api\/indicators\/([^?]+)/);
      if (pathMatch) {
        symbol = pathMatch[1];
      }
    }

    // Validate required parameters
    if (!symbol) {
      return res.status(400).json({ 
        error: 'Missing required parameter: symbol',
        examples: [
          '/api/indicators/BTCUSDT',
          '/api/indicators?symbol=BTCUSDT&intervals=4h,1h,15m,5m'
        ]
      });
    }
    
    // Parse intervals from query
    const { intervals } = req.query;

    // Parse intervals (default to standard set)
    const intervalList = intervals 
      ? intervals.split(',').map(i => i.trim()) 
      : ['4h', '1h', '15m', '5m'];

    console.log(`[Indicators] Fetching ${symbol} for intervals: ${intervalList.join(', ')}`);

    // Fetch multi-timeframe OHLCV data
    const multiData = await marketData.getMultiTimeframeData(symbol, intervalList, 500);

    // Calculate indicators for each timeframe
    const timeframes = {};
    const errors = {};

    for (const [interval, candles] of Object.entries(multiData)) {
      // Check for errors in data fetching
      if (candles && candles.error) {
        errors[interval] = candles.error;
        continue;
      }

      // Validate candles data
      if (!Array.isArray(candles) || candles.length === 0) {
        errors[interval] = 'No data available';
        continue;
      }

      try {
        // Calculate all indicators
        const indicators = indicatorService.calculateAllIndicators(candles);
        const swingPoints = indicatorService.detectSwingPoints(candles, 20);
        
        // Extract key data points for clean API response
        timeframes[interval] = {
          currentPrice: parseFloat(indicators.price.current.toFixed(2)),
          ema21: indicators.ema.ema21 ? parseFloat(indicators.ema.ema21.toFixed(2)) : null,
          ema200: indicators.ema.ema200 ? parseFloat(indicators.ema.ema200.toFixed(2)) : null,
          stoch: {
            k: indicators.stochRSI.k ? parseFloat(indicators.stochRSI.k.toFixed(2)) : null,
            d: indicators.stochRSI.d ? parseFloat(indicators.stochRSI.d.toFixed(2)) : null,
            condition: indicators.stochRSI.condition
          },
          pullback: {
            distanceFrom21: indicators.analysis.distanceFrom21EMA !== null 
              ? parseFloat(indicators.analysis.distanceFrom21EMA.toFixed(2)) 
              : null,
            state: indicators.analysis.pullbackState
          },
          trend: indicators.analysis.trend,
          swingHigh: swingPoints.swingHigh ? parseFloat(swingPoints.swingHigh.toFixed(2)) : null,
          swingLow: swingPoints.swingLow ? parseFloat(swingPoints.swingLow.toFixed(2)) : null,
          candleCount: candles.length
        };

        console.log(`[Indicators] ✅ ${interval}: ${indicators.analysis.trend}`);
      } catch (err) {
        console.error(`[Indicators] ❌ ${interval}: ${err.message}`);
        errors[interval] = err.message;
      }
    }

    // Build response
    const response = {
      symbol,
      source: 'kraken', // Using Kraken as primary data source
      timeframes,
      timestamp: new Date().toISOString()
    };

    // Include errors if any occurred
    if (Object.keys(errors).length > 0) {
      response.errors = errors;
    }

    // Return success response
    return res.status(200).json(response);

  } catch (error) {
    console.error('[Indicators] Error:', error.message);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}

