/**
 * Chart Analysis Module
 * Comprehensive candlestick pattern detection and chart-based analysis
 * 
 * Detects major candlestick patterns and provides chart-based signals
 */

/**
 * Detect candlestick patterns from OHLCV data
 * @param {Array} candles - Array of OHLCV candles (need at least 3 for multi-candle patterns)
 * @returns {Object} Pattern detection results
 */
export function detectCandlestickPatterns(candles) {
  if (!Array.isArray(candles) || candles.length < 1) {
    return {
      current: null,
      confidence: 0,
      bullish: false,
      bearish: false,
      patterns: []
    };
  }

  const patterns = [];
  const latest = candles[candles.length - 1];
  const previous = candles.length > 1 ? candles[candles.length - 2] : null;
  const beforePrevious = candles.length > 2 ? candles[candles.length - 3] : null;

  // Single candle patterns
  if (isHammer(latest)) {
    patterns.push({ name: 'HAMMER', bullish: true, confidence: 0.75 });
  }
  if (isHangingMan(latest)) {
    patterns.push({ name: 'HANGING_MAN', bearish: true, confidence: 0.75 });
  }
  if (isDoji(latest)) {
    patterns.push({ name: 'DOJI', bullish: false, bearish: false, confidence: 0.6 });
  }
  if (isSpinningTop(latest)) {
    patterns.push({ name: 'SPINNING_TOP', bullish: false, bearish: false, confidence: 0.5 });
  }
  if (isShootingStar(latest)) {
    patterns.push({ name: 'SHOOTING_STAR', bearish: true, confidence: 0.7 });
  }
  if (isInvertedHammer(latest)) {
    patterns.push({ name: 'INVERTED_HAMMER', bullish: true, confidence: 0.65 });
  }
  if (isMarubozu(latest)) {
    const bullish = latest.close > latest.open;
    patterns.push({ 
      name: 'MARUBOZU', 
      bullish, 
      bearish: !bullish, 
      confidence: 0.8 
    });
  }

  // Two candle patterns
  if (previous) {
    if (isEngulfingBull(latest, previous)) {
      patterns.push({ name: 'ENGULFING_BULL', bullish: true, confidence: 0.85 });
    }
    if (isEngulfingBear(latest, previous)) {
      patterns.push({ name: 'ENGULFING_BEAR', bearish: true, confidence: 0.85 });
    }
    if (isPiercingPattern(latest, previous)) {
      patterns.push({ name: 'PIERCING_PATTERN', bullish: true, confidence: 0.75 });
    }
    if (isDarkCloudCover(latest, previous)) {
      patterns.push({ name: 'DARK_CLOUD_COVER', bearish: true, confidence: 0.75 });
    }
    if (isHaramiBull(latest, previous)) {
      patterns.push({ name: 'HARAMI_BULL', bullish: true, confidence: 0.65 });
    }
    if (isHaramiBear(latest, previous)) {
      patterns.push({ name: 'HARAMI_BEAR', bearish: true, confidence: 0.65 });
    }
  }

  // Three candle patterns
  if (beforePrevious && previous) {
    if (isMorningStar(latest, previous, beforePrevious)) {
      patterns.push({ name: 'MORNING_STAR', bullish: true, confidence: 0.9 });
    }
    if (isEveningStar(latest, previous, beforePrevious)) {
      patterns.push({ name: 'EVENING_STAR', bearish: true, confidence: 0.9 });
    }
    if (isThreeWhiteSoldiers(latest, previous, beforePrevious)) {
      patterns.push({ name: 'THREE_WHITE_SOLDIERS', bullish: true, confidence: 0.85 });
    }
    if (isThreeBlackCrows(latest, previous, beforePrevious)) {
      patterns.push({ name: 'THREE_BLACK_CROWS', bearish: true, confidence: 0.85 });
    }
  }

  // Determine primary pattern (highest confidence)
  const primaryPattern = patterns.length > 0 
    ? patterns.reduce((max, p) => p.confidence > max.confidence ? p : max, patterns[0])
    : null;

  // Fix: Ensure patterns are mutually exclusive - a pattern cannot be both bullish AND bearish
  // Clean up any patterns that have both flags set incorrectly
  patterns.forEach(p => {
    if (p.bullish && p.bearish) {
      // Pattern is marked both - fix based on pattern name
      const nameLower = p.name.toLowerCase();
      if (nameLower.includes('crow') || nameLower.includes('bear') || 
          nameLower.includes('dark_cloud') || nameLower.includes('evening_star') ||
          nameLower.includes('shooting_star') || nameLower.includes('hanging_man')) {
        p.bullish = false;
        p.bearish = true;
      } else if (nameLower.includes('hammer') || nameLower.includes('bull') || 
                 nameLower.includes('morning_star') || nameLower.includes('soldiers') ||
                 nameLower.includes('piercing') || nameLower.includes('inverted_hammer')) {
        p.bullish = true;
        p.bearish = false;
      } else {
        // Neutral patterns (DOJI, SPINNING_TOP) - keep both false
        p.bullish = false;
        p.bearish = false;
      }
    }
  });

  // Determine overall bullish/bearish from primary pattern (not from all patterns)
  // This ensures mutual exclusivity
  let bullish = false;
  let bearish = false;
  
  if (primaryPattern) {
    bullish = primaryPattern.bullish || false;
    bearish = primaryPattern.bearish || false;
  }

  return {
    current: primaryPattern ? primaryPattern.name : null,
    confidence: primaryPattern ? primaryPattern.confidence : 0,
    bullish,
    bearish,
    patterns: patterns.map(p => p.name),
    allPatterns: patterns
  };
}

/**
 * Analyze wick and body ratios for advanced analysis
 * @param {Array} candles - Array of OHLCV candles
 * @returns {Object} Wick/body analysis
 */
export function analyzeWickBodyRatios(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return null;
  }

  const latest = candles[candles.length - 1];
  if (!latest) return null;

  const range = latest.high - latest.low;
  if (range === 0) return null;

  const body = Math.abs(latest.close - latest.open);
  const upperWick = latest.high - Math.max(latest.open, latest.close);
  const lowerWick = Math.min(latest.open, latest.close) - latest.low;

  const upperWickPct = (upperWick / range) * 100;
  const lowerWickPct = (lowerWick / range) * 100;
  const bodyPct = (body / range) * 100;

  // Determine exhaustion signal
  let exhaustionSignal = 'NONE';
  if (lowerWickPct > 60 && lowerWick > body * 2) {
    exhaustionSignal = 'LOWER_WICK_REJECTION';
  } else if (upperWickPct > 60 && upperWick > body * 2) {
    exhaustionSignal = 'UPPER_WICK_REJECTION';
  } else if (upperWickPct > 30 && lowerWickPct > 30 && bodyPct < 30) {
    exhaustionSignal = 'DOUBLE_WICK_INDECISION';
  }

  return {
    upperWickDominance: parseFloat(upperWickPct.toFixed(2)),
    lowerWickDominance: parseFloat(lowerWickPct.toFixed(2)),
    bodyDominance: parseFloat(bodyPct.toFixed(2)),
    exhaustionSignal,
    upperWickSize: parseFloat(upperWick.toFixed(2)),
    lowerWickSize: parseFloat(lowerWick.toFixed(2)),
    bodySize: parseFloat(body.toFixed(2)),
    range: parseFloat(range.toFixed(2))
  };
}

// ========== Pattern Detection Functions ==========

function isHammer(candle) {
  const body = Math.abs(candle.close - candle.open);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const range = candle.high - candle.low;
  
  return range > 0 &&
         lowerWick > body * 2 &&
         upperWick < body * 0.3 &&
         body > 0;
}

function isHangingMan(candle) {
  // Similar to hammer but appears at top of uptrend
  return isHammer(candle);
}

function isDoji(candle) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  
  return range > 0 && (body / range) < 0.1;
}

function isSpinningTop(candle) {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const range = candle.high - candle.low;
  
  return range > 0 &&
         (body / range) < 0.3 &&
         upperWick > range * 0.3 &&
         lowerWick > range * 0.3;
}

function isShootingStar(candle) {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const range = candle.high - candle.low;
  
  return range > 0 &&
         upperWick > body * 2 &&
         lowerWick < body * 0.3 &&
         body > 0;
}

function isInvertedHammer(candle) {
  // Similar to shooting star but at bottom
  return isShootingStar(candle);
}

function isMarubozu(candle) {
  const body = Math.abs(candle.close - candle.open);
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const range = candle.high - candle.low;
  
  return range > 0 &&
         body > 0 &&
         (upperWick / range) < 0.05 &&
         (lowerWick / range) < 0.05;
}

function isEngulfingBull(current, previous) {
  const currBullish = current.close > current.open;
  const prevBearish = previous.close < previous.open;
  
  return currBullish &&
         prevBearish &&
         current.open < previous.close &&
         current.close > previous.open;
}

function isEngulfingBear(current, previous) {
  const currBearish = current.close < current.open;
  const prevBullish = previous.close > previous.open;
  
  return currBearish &&
         prevBullish &&
         current.open > previous.close &&
         current.close < previous.open;
}

function isPiercingPattern(current, previous) {
  const currBullish = current.close > current.open;
  const prevBearish = previous.close < previous.open;
  const prevMid = (previous.open + previous.close) / 2;
  
  return currBullish &&
         prevBearish &&
         current.open < previous.low &&
         current.close > prevMid &&
         current.close < previous.open;
}

function isDarkCloudCover(current, previous) {
  const currBearish = current.close < current.open;
  const prevBullish = previous.close > previous.open;
  const prevMid = (previous.open + previous.close) / 2;
  
  return currBearish &&
         prevBullish &&
         current.open > previous.high &&
         current.close < prevMid &&
         current.close > previous.close;
}

function isHaramiBull(current, previous) {
  const currBullish = current.close > current.open;
  const prevBearish = previous.close < previous.open;
  
  return currBullish &&
         prevBearish &&
         current.high < previous.high &&
         current.low > previous.low &&
         current.open > previous.close &&
         current.close < previous.open;
}

function isHaramiBear(current, previous) {
  const currBearish = current.close < current.open;
  const prevBullish = previous.close > previous.open;
  
  return currBearish &&
         prevBullish &&
         current.high < previous.high &&
         current.low > previous.low &&
         current.open < previous.close &&
         current.close > previous.open;
}

function isMorningStar(current, previous, beforePrevious) {
  const currBullish = current.close > current.open;
  const prevSmall = Math.abs(previous.close - previous.open) < 
                    (previous.high - previous.low) * 0.3;
  const beforeBearish = beforePrevious.close < beforePrevious.open;
  
  return currBullish &&
         prevSmall &&
         beforeBearish &&
         current.close > beforePrevious.close &&
         previous.low < beforePrevious.low &&
         previous.low < current.low;
}

function isEveningStar(current, previous, beforePrevious) {
  const currBearish = current.close < current.open;
  const prevSmall = Math.abs(previous.close - previous.open) < 
                    (previous.high - previous.low) * 0.3;
  const beforeBullish = beforePrevious.close > beforePrevious.open;
  
  return currBearish &&
         prevSmall &&
         beforeBullish &&
         current.close < beforePrevious.close &&
         previous.high > beforePrevious.high &&
         previous.high > current.high;
}

function isThreeWhiteSoldiers(current, previous, beforePrevious) {
  const allBullish = current.close > current.open &&
                    previous.close > previous.open &&
                    beforePrevious.close > beforePrevious.open;
  
  const ascending = current.close > previous.close &&
                   previous.close > beforePrevious.close;
  
  const smallGaps = current.open <= previous.close * 1.01 &&
                   previous.open <= beforePrevious.close * 1.01;
  
  return allBullish && ascending && smallGaps;
}

function isThreeBlackCrows(current, previous, beforePrevious) {
  const allBearish = current.close < current.open &&
                    previous.close < previous.open &&
                    beforePrevious.close < beforePrevious.open;
  
  const descending = current.close < previous.close &&
                    previous.close < beforePrevious.close;
  
  const smallGaps = current.open >= previous.close * 0.99 &&
                   previous.open >= beforePrevious.close * 0.99;
  
  return allBearish && descending && smallGaps;
}

export default {
  detectCandlestickPatterns,
  analyzeWickBodyRatios
};

