/**
 * Support & Resistance Level Detection
 * 
 * Provides simple support/resistance levels based on:
 * - Recent swing highs/lows
 * - Distance calculations
 * - Break detection
 */

/**
 * Compute support and resistance levels for a timeframe
 * @param {Array} candles - OHLC candle array
 * @param {Number} currentPrice - Current market price
 * @param {Object} swingPoints - Pre-computed swing high/low
 * @param {Number} threshold - % threshold to determine "at level" (default 0.5%)
 * @returns {Object} Levels analysis
 */
export function computeLevels(candles, currentPrice, swingPoints = {}, threshold = 0.5) {
  if (!Array.isArray(candles) || candles.length < 20 || !currentPrice) {
    return {
      nearestResistance: null,
      nearestSupport: null,
      distanceToResistancePct: null,
      distanceToSupportPct: null,
      atResistance: false,
      atSupport: false,
      brokeResistanceOnClose: false,
      brokeSupportOnClose: false
    };
  }

  // Use pre-computed swing points or find pivots
  let nearestResistance = swingPoints.swingHigh || null;
  let nearestSupport = swingPoints.swingLow || null;
  
  // If no swing points provided, find recent pivots
  if (!nearestResistance || !nearestSupport) {
    const pivots = findRecentPivots(candles, currentPrice);
    nearestResistance = nearestResistance || pivots.resistance;
    nearestSupport = nearestSupport || pivots.support;
  }
  
  // Calculate distances
  const distanceToResistancePct = nearestResistance ? 
    Math.abs(((nearestResistance - currentPrice) / currentPrice) * 100) : null;
  const distanceToSupportPct = nearestSupport ? 
    Math.abs(((currentPrice - nearestSupport) / currentPrice) * 100) : null;
  
  // Determine if "at" level (within threshold %)
  const atResistance = nearestResistance ? 
    distanceToResistancePct <= threshold && currentPrice <= nearestResistance : false;
  const atSupport = nearestSupport ? 
    distanceToSupportPct <= threshold && currentPrice >= nearestSupport : false;
  
  // Check for level breaks (current and previous candle)
  const latestCandle = candles[candles.length - 1];
  const previousCandle = candles[candles.length - 2];
  
  const brokeResistanceOnClose = nearestResistance && previousCandle ?
    latestCandle.close > nearestResistance && previousCandle.close <= nearestResistance : false;
  
  const brokeSupportOnClose = nearestSupport && previousCandle ?
    latestCandle.close < nearestSupport && previousCandle.close >= nearestSupport : false;
  
  return {
    nearestResistance: nearestResistance ? parseFloat(nearestResistance.toFixed(2)) : null,
    nearestSupport: nearestSupport ? parseFloat(nearestSupport.toFixed(2)) : null,
    distanceToResistancePct: distanceToResistancePct ? parseFloat(distanceToResistancePct.toFixed(2)) : null,
    distanceToSupportPct: distanceToSupportPct ? parseFloat(distanceToSupportPct.toFixed(2)) : null,
    atResistance,
    atSupport,
    brokeResistanceOnClose,
    brokeSupportOnClose
  };
}

/**
 * Find recent pivot highs and lows
 * Simple algorithm: look for local peaks/troughs in last N candles
 * @param {Array} candles - OHLC candle array
 * @param {Number} currentPrice - Current price to filter relevant levels
 * @param {Number} lookback - Number of candles to analyze (default 50)
 * @returns {Object} { resistance, support }
 */
function findRecentPivots(candles, currentPrice, lookback = 50) {
  const recentCandles = candles.slice(-lookback);
  
  // Find local highs above current price (potential resistance)
  const resistanceCandidates = [];
  for (let i = 2; i < recentCandles.length - 2; i++) {
    const candle = recentCandles[i];
    const prev2 = recentCandles[i - 2];
    const prev1 = recentCandles[i - 1];
    const next1 = recentCandles[i + 1];
    const next2 = recentCandles[i + 2];
    
    // Local high: higher than surrounding candles
    if (candle.high > currentPrice &&
        candle.high >= prev2.high &&
        candle.high >= prev1.high &&
        candle.high >= next1.high &&
        candle.high >= next2.high) {
      resistanceCandidates.push(candle.high);
    }
  }
  
  // Find local lows below current price (potential support)
  const supportCandidates = [];
  for (let i = 2; i < recentCandles.length - 2; i++) {
    const candle = recentCandles[i];
    const prev2 = recentCandles[i - 2];
    const prev1 = recentCandles[i - 1];
    const next1 = recentCandles[i + 1];
    const next2 = recentCandles[i + 2];
    
    // Local low: lower than surrounding candles
    if (candle.low < currentPrice &&
        candle.low <= prev2.low &&
        candle.low <= prev1.low &&
        candle.low <= next1.low &&
        candle.low <= next2.low) {
      supportCandidates.push(candle.low);
    }
  }
  
  // Get nearest levels
  const resistance = resistanceCandidates.length > 0 ?
    Math.min(...resistanceCandidates.filter(r => r > currentPrice)) : null;
  
  const support = supportCandidates.length > 0 ?
    Math.max(...supportCandidates.filter(s => s < currentPrice)) : null;
  
  return { resistance, support };
}

/**
 * Check if price is interacting with a specific level
 * @param {Number} price - Current price
 * @param {Number} level - Support or resistance level
 * @param {Number} thresholdPct - % threshold (default 0.5%)
 * @returns {Boolean} True if price is within threshold of level
 */
export function isAtLevel(price, level, thresholdPct = 0.5) {
  if (!price || !level) return false;
  
  const distance = Math.abs(((level - price) / price) * 100);
  return distance <= thresholdPct;
}

