/**
 * Candle Features & Price Action Analysis
 * 
 * Provides detailed candle-level analysis including:
 * - Candle direction, body size, wick sizes
 * - Price action patterns (rejections, engulfing, inside bars)
 */

/**
 * Describe a single candle with detailed metrics
 * @param {Object} candle - OHLC candle { time, open, high, low, close }
 * @param {Number} ema21 - 21 EMA value for comparison
 * @returns {Object} Candle description
 */
export function describeCandle(candle, ema21 = null) {
  if (!candle || !candle.open || !candle.high || !candle.low || !candle.close) {
    return null;
  }

  const { open, high, low, close } = candle;
  
  // Determine direction
  const isBullish = close > open;
  const isBearish = close < open;
  const direction = isBullish ? 'bull' : isBearish ? 'bear' : 'doji';
  
  // Calculate range
  const totalRange = high - low;
  if (totalRange === 0) {
    return {
      direction: 'doji',
      bodyPct: 0,
      upperWickPct: 0,
      lowerWickPct: 0,
      closeRelativeToRange: 50,
      closeAboveEma21: ema21 ? close > ema21 : null,
      closeBelowEma21: ema21 ? close < ema21 : null,
      range: { open, high, low, close }
    };
  }
  
  // Calculate body size
  const bodySize = Math.abs(close - open);
  const bodyPct = (bodySize / totalRange) * 100;
  
  // Calculate wicks
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const upperWickPct = (upperWick / totalRange) * 100;
  const lowerWickPct = (lowerWick / totalRange) * 100;
  
  // Where is close within the range (0 = at low, 100 = at high)
  const closeRelativeToRange = ((close - low) / totalRange) * 100;
  
  return {
    direction,
    bodyPct: parseFloat(bodyPct.toFixed(2)),
    upperWickPct: parseFloat(upperWickPct.toFixed(2)),
    lowerWickPct: parseFloat(lowerWickPct.toFixed(2)),
    closeRelativeToRange: parseFloat(closeRelativeToRange.toFixed(2)),
    closeAboveEma21: ema21 ? close > ema21 : null,
    closeBelowEma21: ema21 ? close < ema21 : null,
    range: {
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2))
    }
  };
}

/**
 * Detect price action patterns from last 2 candles
 * @param {Object} currentCandle - Latest candle
 * @param {Object} previousCandle - Previous candle
 * @returns {Object} Price action flags
 */
export function detectPriceAction(currentCandle, previousCandle) {
  if (!currentCandle || !previousCandle) {
    return {
      rejectionUp: false,
      rejectionDown: false,
      engulfingBull: false,
      engulfingBear: false,
      insideBar: false
    };
  }

  const curr = currentCandle;
  const prev = previousCandle;
  
  // Helper: check if candle is bullish/bearish
  const currBullish = curr.close > curr.open;
  const currBearish = curr.close < curr.open;
  const prevBullish = prev.close > prev.open;
  const prevBearish = prev.close < prev.open;
  
  // Calculate wick sizes
  const currBody = Math.abs(curr.close - curr.open);
  const currRange = curr.high - curr.low;
  const currUpperWick = curr.high - Math.max(curr.open, curr.close);
  const currLowerWick = Math.min(curr.open, curr.close) - curr.low;
  
  // 1. Rejection Up: Long upper wick (>50% of range), small body (<30%), close near low
  const rejectionUp = 
    currRange > 0 &&
    (currUpperWick / currRange) > 0.5 &&
    (currBody / currRange) < 0.3 &&
    ((curr.close - curr.low) / currRange) < 0.5;
  
  // 2. Rejection Down: Long lower wick (>50% of range), small body (<30%), close near high
  const rejectionDown = 
    currRange > 0 &&
    (currLowerWick / currRange) > 0.5 &&
    (currBody / currRange) < 0.3 &&
    ((curr.high - curr.close) / currRange) < 0.5;
  
  // 3. Engulfing Bull: Current bull candle fully engulfs previous bear candle
  const engulfingBull = 
    currBullish && 
    prevBearish &&
    curr.open < prev.close &&
    curr.close > prev.open;
  
  // 4. Engulfing Bear: Current bear candle fully engulfs previous bull candle
  const engulfingBear = 
    currBearish && 
    prevBullish &&
    curr.open > prev.close &&
    curr.close < prev.open;
  
  // 5. Inside Bar: Current high/low completely inside previous candle range
  const insideBar = 
    curr.high <= prev.high &&
    curr.low >= prev.low;
  
  return {
    rejectionUp,
    rejectionDown,
    engulfingBull,
    engulfingBear,
    insideBar
  };
}

/**
 * Get recent candles for LLM context (last N candles, oldest to newest)
 * @param {Array} candles - Full candle array
 * @param {Number} count - Number of recent candles to return (default 5)
 * @returns {Array} Recent candles with OHLC
 */
export function getRecentCandles(candles, count = 5) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }
  
  const recentCount = Math.min(count, candles.length);
  const recentCandles = candles.slice(-recentCount);
  
  return recentCandles.map(c => ({
    open: parseFloat(c.open.toFixed(2)),
    high: parseFloat(c.high.toFixed(2)),
    low: parseFloat(c.low.toFixed(2)),
    close: parseFloat(c.close.toFixed(2))
  }));
}

