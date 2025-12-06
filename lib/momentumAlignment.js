/**
 * Momentum Alignment Module
 * Multi-timeframe momentum analysis and alignment detection
 * 
 * Analyzes RSI and Stochastic RSI across multiple timeframes to determine
 * momentum confluence and alignment
 */

/**
 * Check momentum alignment across multiple timeframes
 * @param {Object} analysis - Multi-timeframe analysis object (from indicators service)
 * @param {Array<string>} timeframes - Array of timeframes to check (e.g., ['1m', '5m', '15m', '1h', '4h'])
 * @returns {Object} Momentum alignment analysis
 */
export function checkMomentumAlignment(analysis, timeframes = ['1m', '5m', '15m', '1h', '4h']) {
  if (!analysis || typeof analysis !== 'object') {
    return {
      alignment: 'UNKNOWN',
      alignmentScore: 0,
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 0,
      timeframes: {}
    };
  }

  const momentumData = {};
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;

  for (const tf of timeframes) {
    const tfData = analysis[tf];
    if (!tfData || !tfData.indicators) {
      continue;
    }

    const stochRSI = tfData.indicators.stochRSI;
    const rsi = tfData.indicators.rsi || null;

    // Skip if stochRSI is missing or invalid
    if (!stochRSI || typeof stochRSI !== 'object') {
      continue;
    }
    
    // Validate stochRSI has k and d values
    if (typeof stochRSI.k !== 'number' || typeof stochRSI.d !== 'number') {
      continue;
    }

    // Determine momentum direction for this timeframe
    let momentum = 'NEUTRAL';
    let momentumStrength = 0;

    const k = stochRSI.k || 50;
    const d = stochRSI.d || 50;

    // Overbought/Oversold zones
    if (k > 80 && d > 80) {
      momentum = 'BEARISH'; // Overbought = bearish momentum
      momentumStrength = Math.min((k - 80) / 20, 1) * 100;
      bearishCount++;
    } else if (k < 20 && d < 20) {
      momentum = 'BULLISH'; // Oversold = bullish momentum
      momentumStrength = Math.min((20 - k) / 20, 1) * 100;
      bullishCount++;
    } else if (k > d && k > 50) {
      momentum = 'BULLISH';
      momentumStrength = ((k - 50) / 50) * 100;
      bullishCount++;
    } else if (k < d && k < 50) {
      momentum = 'BEARISH';
      momentumStrength = ((50 - k) / 50) * 100;
      bearishCount++;
    } else {
      neutralCount++;
    }

    momentumData[tf] = {
      momentum,
      momentumStrength: parseFloat(momentumStrength.toFixed(2)),
      stochRSI: { k, d },
      rsi: rsi || null
    };
  }

  // Determine overall alignment
  const totalCount = bullishCount + bearishCount + neutralCount;
  let alignment = 'UNKNOWN';
  let alignmentScore = 0;

  if (totalCount === 0) {
    return {
      alignment: 'UNKNOWN',
      alignmentScore: 0,
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 0,
      timeframes: {}
    };
  }

  const bullishRatio = bullishCount / totalCount;
  const bearishRatio = bearishCount / totalCount;

  if (bullishRatio >= 0.6) {
    alignment = 'BULLISH';
    alignmentScore = bullishRatio * 100;
  } else if (bearishRatio >= 0.6) {
    alignment = 'BEARISH';
    alignmentScore = bearishRatio * 100;
  } else if (bullishRatio > bearishRatio) {
    alignment = 'BULLISH_WEAK';
    alignmentScore = bullishRatio * 70;
  } else if (bearishRatio > bullishRatio) {
    alignment = 'BEARISH_WEAK';
    alignmentScore = bearishRatio * 70;
  } else {
    alignment = 'NEUTRAL';
    alignmentScore = 50;
  }

  return {
    alignment,
    alignmentScore: parseFloat(alignmentScore.toFixed(2)),
    bullishCount,
    bearishCount,
    neutralCount,
    totalTimeframes: totalCount,
    timeframes: momentumData
  };
}

/**
 * Calculate momentum score (0-100) for confluence
 * @param {Object} analysis - Multi-timeframe analysis object
 * @returns {Object} Momentum score and breakdown
 */
export function calculateMomentumScore(analysis) {
  const alignment = checkMomentumAlignment(analysis);
  
  // Base score from alignment
  let score = alignment.alignmentScore;
  
  // Bonus for strong alignment (high consensus)
  const consensusRatio = Math.max(
    alignment.bullishCount / alignment.totalTimeframes,
    alignment.bearishCount / alignment.totalTimeframes
  );
  
  if (consensusRatio >= 0.8) {
    score = Math.min(score * 1.2, 100); // 20% bonus for high consensus
  } else if (consensusRatio >= 0.6) {
    score = Math.min(score * 1.1, 100); // 10% bonus for moderate consensus
  }

  // Penalty for mixed signals
  if (alignment.bullishCount > 0 && alignment.bearishCount > 0) {
    const conflictRatio = Math.min(alignment.bullishCount, alignment.bearishCount) / 
                         alignment.totalTimeframes;
    score = score * (1 - conflictRatio * 0.3); // Up to 30% penalty for conflicts
  }

  return {
    score: parseFloat(Math.max(0, Math.min(100, score)).toFixed(2)),
    alignment: alignment.alignment,
    consensusRatio: parseFloat(consensusRatio.toFixed(2)),
    breakdown: alignment
  };
}

/**
 * Detect momentum divergence (price vs momentum)
 * @param {Object} analysis - Multi-timeframe analysis object
 * @param {string} timeframe - Primary timeframe to check (e.g., '4h')
 * @returns {Object} Divergence detection results
 */
export function detectMomentumDivergence(analysis, timeframe = '4h') {
  const tfData = analysis[timeframe];
  if (!tfData || !tfData.indicators || !tfData.candles) {
    return {
      divergence: 'NONE',
      type: null,
      confidence: 0
    };
  }

  const candles = tfData.candles;
  const stochRSI = tfData.indicators.stochRSI;
  
  if (!candles || candles.length < 10 || !stochRSI) {
    return {
      divergence: 'NONE',
      type: null,
      confidence: 0
    };
  }

  // Get recent price action (last 5-10 candles)
  const recentCandles = candles.slice(-10);
  const recentPrices = recentCandles.map(c => c.close);
  
  // Get recent momentum (would need stochRSI history)
  // For now, use current stochRSI and trend
  const currentPrice = recentPrices[recentPrices.length - 1];
  const previousPrice = recentPrices[0];
  const priceTrend = currentPrice > previousPrice ? 'UP' : 'DOWN';
  
  const currentMomentum = stochRSI.k || 50;
  const momentumTrend = currentMomentum > 50 ? 'UP' : 'DOWN';

  // Bullish divergence: price making lower lows, momentum making higher lows
  // Bearish divergence: price making higher highs, momentum making lower highs
  
  // Simplified check: if price and momentum are moving in opposite directions
  if (priceTrend === 'DOWN' && momentumTrend === 'UP' && currentMomentum < 30) {
    return {
      divergence: 'BULLISH',
      type: 'BULLISH_DIVERGENCE',
      confidence: 0.7,
      description: 'Price declining but momentum improving (bullish divergence)'
    };
  }

  if (priceTrend === 'UP' && momentumTrend === 'DOWN' && currentMomentum > 70) {
    return {
      divergence: 'BEARISH',
      type: 'BEARISH_DIVERGENCE',
      confidence: 0.7,
      description: 'Price rising but momentum weakening (bearish divergence)'
    };
  }

  return {
    divergence: 'NONE',
    type: null,
    confidence: 0
  };
}

/**
 * Get overall momentum bias from multiple timeframes
 * @param {Object} analysis - Multi-timeframe analysis object
 * @param {Array<string>} timeframes - Timeframes to consider
 * @returns {Object} Overall momentum bias
 */
export function getMomentumBias(analysis, timeframes = ['15m', '1h', '4h']) {
  const alignment = checkMomentumAlignment(analysis, timeframes);
  
  let bias = 'NEUTRAL';
  let strength = 0;

  if (alignment.alignment === 'BULLISH' || alignment.alignment === 'BULLISH_WEAK') {
    bias = 'BULLISH';
    strength = alignment.alignmentScore;
  } else if (alignment.alignment === 'BEARISH' || alignment.alignment === 'BEARISH_WEAK') {
    bias = 'BEARISH';
    strength = alignment.alignmentScore;
  }

  return {
    bias,
    strength: parseFloat(strength.toFixed(2)),
    alignment: alignment.alignment,
    confidence: alignment.totalTimeframes >= 3 ? 'HIGH' : 'MEDIUM'
  };
}

export default {
  checkMomentumAlignment,
  calculateMomentumScore,
  detectMomentumDivergence,
  getMomentumBias
};

