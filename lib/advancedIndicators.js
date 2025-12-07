/**
 * Advanced Indicators Module
 * 
 * Provides VWAP, ATR, Bollinger Bands, and MA stack analysis
 */

/**
 * Calculate VWAP (Volume Weighted Average Price)
 * @param {Array} candles - OHLCV array
 * @param {Number} currentPrice - Current price
 * @param {Number} lookback - Number of candles to use (default: all candles in session/window)
 * @returns {Object} VWAP analysis
 */
export function calculateVWAP(candles, currentPrice, lookback = null) {
  if (!Array.isArray(candles) || candles.length === 0 || !currentPrice) {
    return null;
  }

  // Use lookback or all candles
  const windowCandles = lookback ? candles.slice(-lookback) : candles;
  
  // Check if volume data exists
  const hasVolume = windowCandles.every(c => c.volume !== undefined && c.volume !== null);
  if (!hasVolume) {
    return null; // No volume data available
  }

  // Calculate VWAP: sum(typical_price * volume) / sum(volume)
  let sumPriceVolume = 0;
  let sumVolume = 0;

  for (const candle of windowCandles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    const volume = candle.volume;
    
    sumPriceVolume += typicalPrice * volume;
    sumVolume += volume;
  }

  if (sumVolume === 0) {
    return null;
  }

  const vwapValue = sumPriceVolume / sumVolume;
  const distancePct = ((currentPrice - vwapValue) / currentPrice) * 100;
  const above = currentPrice > vwapValue;
  const below = currentPrice < vwapValue;
  const atVwap = Math.abs(distancePct) < 0.2; // Within 0.2%
  const reversionZone = Math.abs(distancePct) > 2.0; // More than 2% away

  return {
    value: parseFloat(vwapValue.toFixed(2)),
    distancePct: parseFloat(distancePct.toFixed(2)),
    above,
    below,
    bias: above ? 'long' : 'short',
    atVwap,
    reversionZone
  };
}

/**
 * Determine trapped positioning based on VWAP and trend
 * @param {Object} vwap - VWAP data
 * @param {String} trend - Current trend (UPTREND/DOWNTREND/FLAT)
 * @returns {Object} Trapped positioning
 */
export function determineVWAPPositioning(vwap, trend) {
  if (!vwap || !trend) {
    return {
      trappedLongsLikely: false,
      trappedShortsLikely: false
    };
  }

  const trappedLongsLikely = 
    vwap.below && 
    trend === 'DOWNTREND' && 
    vwap.distancePct < -0.5;

  const trappedShortsLikely = 
    vwap.above && 
    trend === 'UPTREND' && 
    vwap.distancePct > 0.5;

  return {
    trappedLongsLikely,
    trappedShortsLikely
  };
}

/**
 * Calculate ATR (Average True Range)
 * @param {Array} candles - OHLCV array
 * @param {Number} period - ATR period (default 14)
 * @returns {Object} ATR analysis
 */
export function calculateATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) {
    return null;
  }

  // Calculate True Range for each candle
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    
    trueRanges.push(tr);
  }

  // Calculate ATR using Wilder's smoothing method (simplified EMA)
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  
  for (let i = period; i < trueRanges.length; i++) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;

  // Classify volatility state
  // Classify volatility state - Always set state (never null)
  let volatilityState = 'NORMAL';
  if (atrPct < 0.5) {
    volatilityState = 'LOW';
  } else if (atrPct > 2.0) {
    volatilityState = 'HIGH';
  } else if (atrPct > 5.0) {
    volatilityState = 'EXTREME';
  }
  
  // Ensure state is always lowercase and valid
  volatilityState = volatilityState.toLowerCase();
  if (!['low', 'normal', 'high', 'extreme'].includes(volatilityState)) {
    volatilityState = 'normal';
  }

  return {
    atr: parseFloat(atr.toFixed(2)),
    atrPct: parseFloat(atrPct.toFixed(2)),
    volatilityState
  };
}

/**
 * Calculate Bollinger Bands
 * @param {Array} candles - OHLCV array
 * @param {Number} period - BB period (default 20)
 * @param {Number} stdDev - Standard deviation multiplier (default 2)
 * @returns {Object} Bollinger Bands analysis
 */
export function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  if (!Array.isArray(candles) || candles.length < period) {
    return null;
  }

  const closes = candles.map(c => c.close);
  const recentCloses = closes.slice(-period);
  
  // Calculate SMA (middle band)
  const sum = recentCloses.reduce((acc, val) => acc + val, 0);
  const mid = sum / period;
  
  // Calculate standard deviation
  const squaredDiffs = recentCloses.map(close => Math.pow(close - mid, 2));
  const variance = squaredDiffs.reduce((acc, val) => acc + val, 0) / period;
  const std = Math.sqrt(variance);
  
  // Calculate bands
  const upper = mid + (stdDev * std);
  const lower = mid - (stdDev * std);
  
  const currentPrice = candles[candles.length - 1].close;
  
  // Calculate bandwidth (volatility measure)
  const bandWidthPct = ((upper - lower) / mid) * 100;
  
  // Detect squeeze (low volatility)
  const squeeze = bandWidthPct < 2.0; // Less than 2% bandwidth = squeeze
  
  // Calculate price position within bands (0 = lower band, 50 = mid, 100 = upper)
  let pricePosPct = 50;
  if (upper !== lower) {
    pricePosPct = ((currentPrice - lower) / (upper - lower)) * 100;
    pricePosPct = Math.max(0, Math.min(100, pricePosPct)); // Clamp to 0-100
  }

  return {
    mid: parseFloat(mid.toFixed(2)),
    upper: parseFloat(upper.toFixed(2)),
    lower: parseFloat(lower.toFixed(2)),
    bandWidthPct: parseFloat(bandWidthPct.toFixed(2)),
    squeeze,
    pricePosPct: parseFloat(pricePosPct.toFixed(2))
  };
}

/**
 * Calculate EMA
 * @param {Array} values - Array of values
 * @param {Number} period - EMA period
 * @returns {Number} EMA value
 */
function calculateEMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  
  // Start with SMA
  let ema = values.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  
  // Apply EMA formula for remaining values
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Calculate moving average stack
 * @param {Array} candles - OHLCV array
 * @param {Object} existingEmas - Pre-calculated EMAs (ema21, ema200)
 * @returns {Object} MA stack analysis
 */
export function calculateMAStack(candles, existingEmas = {}) {
  if (!Array.isArray(candles) || candles.length < 200) {
    return null;
  }

  const closes = candles.map(c => c.close);
  
  // Calculate EMA50 if not provided
  const ema21 = existingEmas.ema21 || null;
  const ema50 = calculateEMA(closes, 50);
  const ema200 = existingEmas.ema200 || null;

  if (!ema21 || !ema50 || !ema200) {
    return {
      ema21: ema21 ? parseFloat(ema21.toFixed(2)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(2)) : null,
      ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null,
      bullStack: false,
      bearStack: false,
      flatStack: false
    };
  }

  // Determine stack alignment
  const bullStack = ema21 > ema50 && ema50 > ema200;
  const bearStack = ema21 < ema50 && ema50 < ema200;
  const flatStack = !bullStack && !bearStack;

  return {
    ema21: parseFloat(ema21.toFixed(2)),
    ema50: parseFloat(ema50.toFixed(2)),
    ema200: parseFloat(ema200.toFixed(2)),
    bullStack,
    bearStack,
    flatStack
  };
}

/**
 * Calculate all advanced indicators for a timeframe
 * @param {Array} candles - OHLCV array
 * @param {Number} currentPrice - Current price
 * @param {String} trend - Current trend
 * @param {Object} existingEmas - Pre-calculated EMAs
 * @param {String} timeframe - Timeframe string (e.g., '4h', '1h')
 * @returns {Object} All advanced indicators
 */
export function calculateAllAdvanced(candles, currentPrice, trend, existingEmas = {}, timeframe = null) {
  const result = {};

  // VWAP (for intraday timeframes: 5m, 15m, 1h)
  const shouldCalculateVWAP = ['5m', '15m', '1h'].includes(timeframe);
  if (shouldCalculateVWAP) {
    const vwap = calculateVWAP(candles, currentPrice);
    if (vwap) {
      result.vwap = vwap;
      result.vwapPositioning = determineVWAPPositioning(vwap, trend);
    }
  }

  // ATR (all timeframes)
  const volatility = calculateATR(candles);
  if (volatility) {
    result.volatility = volatility;
  }

  // Bollinger Bands (for 4h, 1h, 15m)
  const shouldCalculateBB = ['4h', '1h', '15m'].includes(timeframe);
  if (shouldCalculateBB) {
    const bollinger = calculateBollingerBands(candles);
    if (bollinger) {
      result.bollinger = bollinger;
    }
  }

  // MA Stack (for 4h and 1h only - most relevant for trend structure)
  const shouldCalculateMAStack = ['4h', '1h'].includes(timeframe);
  if (shouldCalculateMAStack) {
    const maStack = calculateMAStack(candles, existingEmas);
    if (maStack) {
      result.movingAverages = {
        ema21: maStack.ema21,
        ema50: maStack.ema50,
        ema200: maStack.ema200
      };
      result.maStructure = {
        bullStack: maStack.bullStack,
        bearStack: maStack.bearStack,
        flatStack: maStack.flatStack
      };
    }
  }

  return result;
}

