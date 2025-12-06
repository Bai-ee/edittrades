/**
 * Technical Indicators Service
 * Calculates EMA, Stochastic RSI, and other indicators
 * Uses technicalindicators library for accurate calculations
 */

import { EMA, StochasticRSI, RSI, ADX } from 'technicalindicators';
import * as chartAnalysis from '../lib/chartAnalysis.js';
import * as candleFeatures from '../lib/candleFeatures.js';

/**
 * Calculate 21 EMA from price data
 * @param {Array<number>} prices - Array of close prices
 * @returns {Array<number>} EMA values
 */
export function calculateEMA21(prices) {
  if (prices.length < 21) {
    throw new Error('Not enough data points for 21 EMA (need at least 21)');
  }

  return EMA.calculate({
    period: 21,
    values: prices
  });
}

/**
 * Calculate 200 EMA from price data
 * @param {Array<number>} prices - Array of close prices
 * @returns {Array<number>} EMA values
 */
export function calculateEMA200(prices) {
  if (prices.length < 200) {
    throw new Error('Not enough data points for 200 EMA (need at least 200)');
  }

  return EMA.calculate({
    period: 200,
    values: prices
  });
}

/**
 * Calculate Stochastic RSI
 * @param {Array<number>} prices - Array of close prices
 * @param {Object} params - Stochastic RSI parameters
 * @returns {Array<Object>} Array of {k, d} values
 */
export function calculateStochasticRSI(prices, params = {}) {
  const {
    rsiPeriod = 14,
    stochasticPeriod = 14,
    kPeriod = 3,
    dPeriod = 3
  } = params;

  if (prices.length < rsiPeriod + stochasticPeriod) {
    throw new Error(`Not enough data points for Stochastic RSI (need at least ${rsiPeriod + stochasticPeriod})`);
  }

  return StochasticRSI.calculate({
    values: prices,
    rsiPeriod,
    stochasticPeriod,
    kPeriod,
    dPeriod
  });
}

/**
 * Calculate all indicators for a given dataset
 * @param {Array<Object>} candles - Array of OHLCV candles
 * @returns {Object} Object with all calculated indicators
 */
export function calculateAllIndicators(candles) {
  if (!candles || candles.length === 0) {
    throw new Error('No candle data provided');
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Calculate EMAs
  let ema21, ema200;
  try {
    ema21 = calculateEMA21(closes);
  } catch (error) {
    ema21 = null;
  }

  try {
    ema200 = calculateEMA200(closes);
  } catch (error) {
    ema200 = null;
  }

  // Calculate Stochastic RSI
  let stochRSI;
  try {
    stochRSI = calculateStochasticRSI(closes);
  } catch (error) {
    stochRSI = null;
  }

  // Get current values (last element)
  const currentPrice = closes[closes.length - 1];
  const currentEMA21 = ema21 ? ema21[ema21.length - 1] : null;
  const currentEMA200 = ema200 ? ema200[ema200.length - 1] : null;
  const currentStochRSI = stochRSI ? stochRSI[stochRSI.length - 1] : null;

  // Calculate trend (from PRD: price > 21 EMA > 200 EMA = uptrend)
  let trend = 'FLAT';
  if (currentEMA21 && currentEMA200) {
    if (currentPrice > currentEMA21 && currentEMA21 > currentEMA200) {
      trend = 'UPTREND';
    } else if (currentPrice < currentEMA21 && currentEMA21 < currentEMA200) {
      trend = 'DOWNTREND';
    }
  }

  // Determine Stochastic RSI conditions
  let stochCondition = 'NEUTRAL';
  if (currentStochRSI) {
    if (currentStochRSI.k > 80 && currentStochRSI.d > 80) {
      stochCondition = 'OVERBOUGHT';
    } else if (currentStochRSI.k < 20 && currentStochRSI.d < 20) {
      stochCondition = 'OVERSOLD';
    } else if (currentStochRSI.k > currentStochRSI.d) {
      stochCondition = 'BULLISH';
    } else if (currentStochRSI.k < currentStochRSI.d) {
      stochCondition = 'BEARISH';
    }
  }

  // Calculate distance from 21 EMA (for pullback detection)
  let distanceFrom21EMA = null;
  let pullbackState = 'UNKNOWN';
  if (currentEMA21) {
    distanceFrom21EMA = ((currentPrice - currentEMA21) / currentEMA21) * 100;
    
    if (Math.abs(distanceFrom21EMA) < 0.5) {
      pullbackState = 'ENTRY_ZONE'; // At the 21 EMA
    } else if (Math.abs(distanceFrom21EMA) > 3) {
      pullbackState = 'OVEREXTENDED'; // Far from 21 EMA
    } else {
      pullbackState = 'RETRACING'; // Moving toward 21 EMA
    }
  }

  // Calculate RSI for momentum analysis
  let rsi = null;
  let currentRSI = null;
  try {
    if (closes.length >= 14) {
      rsi = RSI.calculate({ values: closes, period: 14 });
      currentRSI = rsi.length > 0 ? rsi[rsi.length - 1] : null;
    }
  } catch (error) {
    console.warn('[Indicators] RSI calculation error:', error.message);
  }

  // Calculate ADX for trend strength
  let adx = null;
  let currentADX = null;
  let trendStrength = null;
  try {
    if (closes.length >= 14 && highs.length >= 14 && lows.length >= 14) {
      adx = ADX.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14
      });
      currentADX = adx.length > 0 ? adx[adx.length - 1] : null;
      
      if (currentADX !== null) {
        trendStrength = {
          adx: parseFloat(currentADX.toFixed(2)),
          strong: currentADX >= 25,
          weak: currentADX < 25,
          veryStrong: currentADX >= 40,
          category: currentADX >= 40 ? 'VERY_STRONG' : 
                   currentADX >= 25 ? 'STRONG' : 
                   currentADX >= 20 ? 'MODERATE' : 'WEAK'
        };
      }
    }
  } catch (error) {
    console.warn('[Indicators] ADX calculation error:', error.message);
  }

  // Detect candlestick patterns
  let candlestickPatterns = null;
  try {
    candlestickPatterns = chartAnalysis.detectCandlestickPatterns(candles);
  } catch (error) {
    console.warn('[Indicators] Pattern detection error:', error.message);
  }

  // Analyze wick/body ratios
  let wickAnalysis = null;
  try {
    wickAnalysis = chartAnalysis.analyzeWickBodyRatios(candles);
    
    // Enhance with candleFeatures functions
    if (candles.length > 0) {
      const latest = candles[candles.length - 1];
      const wickDominance = candleFeatures.calculateWickDominance(latest);
      const bodyStrength = candleFeatures.analyzeBodyStrength(latest);
      const exhaustionSignals = candleFeatures.detectExhaustionSignals(candles.slice(-3));
      
      if (wickAnalysis) {
        wickAnalysis.wickDominance = wickDominance;
        wickAnalysis.bodyStrength = bodyStrength;
        wickAnalysis.exhaustionSignals = exhaustionSignals;
      }
    }
  } catch (error) {
    console.warn('[Indicators] Wick analysis error:', error.message);
  }

  return {
    price: {
      current: currentPrice,
      high: Math.max(...highs),
      low: Math.min(...lows)
    },
    ema: {
      ema21: currentEMA21,
      ema200: currentEMA200,
      ema21History: ema21,
      ema200History: ema200
    },
    stochRSI: {
      // Clamp k and d to [0, 100] to prevent floating-point noise
      k: currentStochRSI?.k != null ? Math.min(100, Math.max(0, currentStochRSI.k)) : null,
      d: currentStochRSI?.d != null ? Math.min(100, Math.max(0, currentStochRSI.d)) : null,
      condition: stochCondition,
      history: stochRSI
    },
    rsi: currentRSI ? {
      value: parseFloat(currentRSI.toFixed(2)),
      history: rsi,
      overbought: currentRSI > 70,
      oversold: currentRSI < 30
    } : null,
    analysis: {
      trend,
      pullbackState,
      distanceFrom21EMA
    },
    trendStrength,
    candlestickPatterns,
    wickAnalysis,
    metadata: {
      candleCount: candles.length,
      lastUpdate: new Date(candles[candles.length - 1].timestamp).toISOString()
    }
  };
}

/**
 * Detect swing highs and lows (market structure)
 * @param {Array<Object>} candles - Array of OHLCV candles
 * @param {number} lookback - Number of candles to look back (default: 20)
 * @returns {Object} Swing high and low
 */
export function detectSwingPoints(candles, lookback = 20) {
  if (candles.length < lookback) {
    return { swingHigh: null, swingLow: null };
  }

  const recentCandles = candles.slice(-lookback);
  const highs = recentCandles.map(c => c.high);
  const lows = recentCandles.map(c => c.low);

  const swingHigh = Math.max(...highs);
  const swingLow = Math.min(...lows);

  return { swingHigh, swingLow };
}

/**
 * Check if there's a wick rejection (long wick, small body)
 * @param {Object} candle - Single OHLC candle
 * @returns {string} 'BULLISH_REJECTION', 'BEARISH_REJECTION', or 'NONE'
 */
export function detectWickRejection(candle) {
  const bodySize = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  const totalRange = candle.high - candle.low;

  // Rejection: wick is at least 2x body size and >50% of total range
  if (lowerWick > bodySize * 2 && lowerWick > totalRange * 0.5) {
    return 'BULLISH_REJECTION'; // Rejected downside, bullish
  }
  
  if (upperWick > bodySize * 2 && upperWick > totalRange * 0.5) {
    return 'BEARISH_REJECTION'; // Rejected upside, bearish
  }

  return 'NONE';
}

export default {
  calculateEMA21,
  calculateEMA200,
  calculateStochasticRSI,
  calculateAllIndicators,
  detectSwingPoints,
  detectWickRejection
};



