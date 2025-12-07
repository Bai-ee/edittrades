/**
 * Data Validation Module
 * 
 * Validates and sanitizes advanced chart analysis data to ensure consistency
 */

/**
 * Validate and fix candlestick patterns
 * @param {Object} patterns - Candlestick patterns object
 * @returns {Object} Validated patterns object
 */
export function validateCandlestickPatterns(patterns) {
  if (!patterns) {
    return patterns;
  }

  // Handle both allPatterns array and direct pattern object
  let fixedPatterns = [];
  if (patterns.allPatterns && Array.isArray(patterns.allPatterns)) {
    fixedPatterns = patterns.allPatterns.map(p => {
      const fixed = { ...p };
      
      // Fix: Pattern cannot be both bullish AND bearish
      if (fixed.bullish && fixed.bearish) {
        const nameLower = fixed.name.toLowerCase();
        
        // Bearish patterns (ALWAYS bearish)
        if (nameLower.includes('three_black_crows') || nameLower.includes('crow') || 
            nameLower.includes('engulfing_bear') || nameLower.includes('bear') || 
            nameLower.includes('dark_cloud') || nameLower.includes('evening_star') ||
            nameLower.includes('shooting_star') || nameLower.includes('hanging_man')) {
          fixed.bullish = false;
          fixed.bearish = true;
        } 
        // Bullish patterns (ALWAYS bullish)
        else if (nameLower.includes('hammer') || nameLower.includes('engulfing_bull') || 
                 nameLower.includes('bull') || nameLower.includes('morning_star') || 
                 nameLower.includes('three_white_soldiers') || nameLower.includes('soldiers') ||
                 nameLower.includes('piercing') || nameLower.includes('inverted_hammer') ||
                 nameLower.includes('harami_bull')) {
          fixed.bullish = true;
          fixed.bearish = false;
        } 
        // Neutral patterns (DOJI, SPINNING_TOP)
        else {
          fixed.bullish = false;
          fixed.bearish = false;
        }
      }
      // Also fix if both are false but pattern name suggests direction
      else if (!fixed.bullish && !fixed.bearish) {
        const nameLower = fixed.name.toLowerCase();
        if (nameLower.includes('three_black_crows') || nameLower.includes('crow') || 
            nameLower.includes('engulfing_bear') || nameLower.includes('dark_cloud') ||
            nameLower.includes('evening_star') || nameLower.includes('shooting_star') ||
            nameLower.includes('hanging_man')) {
          fixed.bearish = true;
        } else if (nameLower.includes('hammer') || nameLower.includes('engulfing_bull') ||
                   nameLower.includes('morning_star') || nameLower.includes('soldiers') ||
                   nameLower.includes('piercing') || nameLower.includes('inverted_hammer') ||
                   nameLower.includes('harami_bull')) {
          fixed.bullish = true;
        }
      }
      
      return fixed;
    });
  }

  // Recalculate top-level bullish/bearish from primary pattern only
  const primaryPattern = fixedPatterns.length > 0 
    ? fixedPatterns.reduce((max, p) => (p.confidence || 0) > (max.confidence || 0) ? p : max, fixedPatterns[0])
    : null;

  const result = {
    ...patterns,
    bullish: primaryPattern ? (primaryPattern.bullish || false) : (patterns.bullish || false),
    bearish: primaryPattern ? (primaryPattern.bearish || false) : (patterns.bearish || false)
  };

  if (fixedPatterns.length > 0) {
    result.allPatterns = fixedPatterns;
  }

  // Final safety check: ensure mutual exclusivity at top level
  if (result.bullish && result.bearish) {
    // If both are true, use primary pattern to decide
    if (primaryPattern) {
      result.bullish = primaryPattern.bullish || false;
      result.bearish = primaryPattern.bearish || false;
    } else {
      // Default to bearish if we can't determine (conservative)
      result.bullish = false;
    }
  }

  return result;
}

/**
 * Validate and fix volume profile
 * @param {Object} volumeProfile - Volume profile object
 * @param {Number} currentPrice - Current price for sanity checks
 * @returns {Object} Validated volume profile
 */
export function validateVolumeProfile(volumeProfile, currentPrice) {
  if (!volumeProfile) {
    return volumeProfile;
  }

  const fixed = { ...volumeProfile };

  // Fix: Ensure valueAreaLow < valueAreaHigh
  if (fixed.valueAreaLow > fixed.valueAreaHigh) {
    console.warn('[Validation] Volume profile value area inverted, swapping:', {
      low: fixed.valueAreaLow,
      high: fixed.valueAreaHigh
    });
    [fixed.valueAreaLow, fixed.valueAreaHigh] = [fixed.valueAreaHigh, fixed.valueAreaLow];
  }

  // Validate HVN nodes
  if (fixed.highVolumeNodes && Array.isArray(fixed.highVolumeNodes)) {
    fixed.highVolumeNodes = fixed.highVolumeNodes
      .filter(node => node && node.price > 0 && node.volume >= 0)
      .map(node => ({
        price: parseFloat(node.price.toFixed(2)),
        volume: parseFloat(node.volume.toFixed(2))
      }));
  }

  // Validate LVN nodes
  if (fixed.lowVolumeNodes && Array.isArray(fixed.lowVolumeNodes)) {
    fixed.lowVolumeNodes = fixed.lowVolumeNodes
      .filter(node => node && node.price > 0 && node.volume >= 0)
      .map(node => ({
        price: parseFloat(node.price.toFixed(2)),
        volume: parseFloat(node.volume.toFixed(2))
      }));
  }

  return fixed;
}

/**
 * Validate and fix volatility (ATR)
 * @param {Object} volatility - Volatility object
 * @param {Number} currentPrice - Current price for consistency check
 * @returns {Object} Validated volatility
 */
export function validateVolatility(volatility, currentPrice) {
  if (!volatility || !currentPrice || currentPrice <= 0) {
    return volatility;
  }

  const fixed = { ...volatility };

  // Recalculate ATR percentage to ensure consistency
  if (fixed.atr && fixed.atr > 0) {
    const expectedPct = (fixed.atr / currentPrice) * 100;
    const delta = Math.abs(expectedPct - fixed.atrPctOfPrice);

    if (delta > 0.5) {
      console.warn('[Validation] ATR percentage mismatch, recalculating:', {
        atr: fixed.atr,
        price: currentPrice,
        reportedPct: fixed.atrPctOfPrice,
        expectedPct,
        delta
      });
      fixed.atrPctOfPrice = parseFloat(expectedPct.toFixed(2));
    }
  }

  // Validate state enum
  const validStates = ['low', 'normal', 'high', 'extreme'];
  if (fixed.state && !validStates.includes(fixed.state.toLowerCase())) {
    console.warn('[Validation] Invalid volatility state:', fixed.state);
    // Auto-fix based on ATR percentage
    const pct = fixed.atrPctOfPrice || 0;
    if (pct < 0.5) fixed.state = 'low';
    else if (pct > 2.0) fixed.state = 'high';
    else fixed.state = 'normal';
  }

  return fixed;
}

/**
 * Validate and fix fair value gaps
 * @param {Array} fairValueGaps - Array of FVG objects
 * @returns {Array} Validated FVG array
 */
export function validateFairValueGaps(fairValueGaps) {
  if (!Array.isArray(fairValueGaps)) {
    return [];
  }

  return fairValueGaps
    .filter(gap => gap && typeof gap === 'object')
    .map(gap => {
      const fixed = { ...gap };

      // Fix: Ensure low < high
      if (fixed.low >= fixed.high) {
        console.warn('[Validation] FVG bounds inverted, swapping:', {
          low: fixed.low,
          high: fixed.high,
          direction: fixed.direction
        });
        [fixed.low, fixed.high] = [fixed.high, fixed.low];
      }

      // Validate direction enum
      if (!['bullish', 'bearish'].includes(fixed.direction)) {
        console.warn('[Validation] Invalid FVG direction:', fixed.direction);
        // Auto-detect from price relationship
        fixed.direction = fixed.low < fixed.high ? 'bullish' : 'bearish';
      }

      return {
        direction: fixed.direction,
        low: parseFloat(fixed.low.toFixed(2)),
        high: parseFloat(fixed.high.toFixed(2)),
        filled: fixed.filled === true,
        candleIndex: fixed.candleIndex || null
      };
    });
}

/**
 * Validate and fix market structure
 * @param {Object} marketStructure - Market structure object
 * @returns {Object} Validated market structure
 */
export function validateMarketStructure(marketStructure) {
  if (!marketStructure) {
    return marketStructure;
  }

  const fixed = { ...marketStructure };

  // Validate currentStructure enum
  const validStructures = ['uptrend', 'downtrend', 'flat', 'range', 'unknown'];
  if (fixed.currentStructure && !validStructures.includes(fixed.currentStructure.toLowerCase())) {
    console.warn('[Validation] Invalid market structure currentStructure:', fixed.currentStructure);
    fixed.currentStructure = 'unknown';
  }

  // Validate lastSwings
  if (fixed.lastSwings && Array.isArray(fixed.lastSwings)) {
    fixed.lastSwings = fixed.lastSwings
      .filter(swing => swing && swing.price > 0)
      .map(swing => ({
        type: swing.type || 'UNKNOWN',
        price: parseFloat(swing.price.toFixed(2)),
        timestamp: swing.timestamp || null
      }));
  }

  // Validate lastBos and lastChoch
  if (fixed.lastBos) {
    if (!['bullish', 'bearish', 'neutral'].includes(fixed.lastBos.direction)) {
      fixed.lastBos.direction = 'neutral';
    }
  }

  if (fixed.lastChoch) {
    if (!['bullish', 'bearish', 'neutral'].includes(fixed.lastChoch.direction)) {
      fixed.lastChoch.direction = 'neutral';
    }
  }

  return fixed;
}

/**
 * Validate and fix liquidity zones
 * @param {Array} liquidityZones - Array of liquidity zone objects
 * @returns {Array} Validated liquidity zones
 */
export function validateLiquidityZones(liquidityZones) {
  if (!Array.isArray(liquidityZones)) {
    return [];
  }

  return liquidityZones
    .filter(zone => zone && typeof zone === 'object' && zone.price > 0)
    .map(zone => {
      const fixed = { ...zone };

      // Validate type enum
      const validTypes = ['equal_highs', 'equal_lows', 'swing_high_cluster', 'swing_low_cluster'];
      if (!validTypes.includes(fixed.type)) {
        console.warn('[Validation] Invalid liquidity zone type:', fixed.type);
        return null;
      }

      // Validate side enum
      if (!['buy', 'sell'].includes(fixed.side)) {
        // Auto-fix based on type
        fixed.side = fixed.type.includes('high') ? 'sell' : 'buy';
      }

      // Clamp strength to 0-100
      if (fixed.strength !== undefined) {
        fixed.strength = Math.max(0, Math.min(100, Math.round(fixed.strength)));
      }

      return {
        type: fixed.type,
        price: parseFloat(fixed.price.toFixed(2)),
        tolerance: fixed.tolerance ? parseFloat(fixed.tolerance.toFixed(2)) : 0,
        strength: fixed.strength || 40,
        side: fixed.side,
        touches: Math.max(1, Math.round(fixed.touches || 1))
      };
    })
    .filter(zone => zone !== null);
}

/**
 * Validate and fix divergences
 * @param {Array} divergences - Array of divergence objects
 * @returns {Array} Validated divergences
 */
export function validateDivergences(divergences) {
  if (!Array.isArray(divergences)) {
    return [];
  }

  const allowedTypes = ['regular', 'hidden'];
  const allowedSides = ['bullish', 'bearish'];
  const allowedOscillators = ['RSI', 'StochRSI'];

  return divergences
    .filter(div => div && typeof div === 'object')
    .map(div => {
      const fixed = { ...div };

      // Validate type
      if (!allowedTypes.includes(fixed.type)) {
        console.warn('[Validation] Invalid divergence type:', fixed.type);
        return null;
      }

      // Validate side
      if (!allowedSides.includes(fixed.side)) {
        console.warn('[Validation] Invalid divergence side:', fixed.side);
        return null;
      }

      // Validate oscillator
      if (fixed.oscillator && !allowedOscillators.includes(fixed.oscillator)) {
        console.warn('[Validation] Invalid divergence oscillator:', fixed.oscillator);
        fixed.oscillator = 'RSI'; // Default
      }

      return fixed;
    })
    .filter(div => div !== null);
}

/**
 * Validate entire timeframe analysis object
 * @param {Object} tfData - Timeframe analysis data
 * @param {Number} currentPrice - Current price for validation
 * @returns {Object} Validated timeframe data
 */
export function validateTimeframeAnalysis(tfData, currentPrice) {
  if (!tfData) {
    return tfData;
  }

  const validated = { ...tfData };

  // Validate candlestick patterns
  if (validated.indicators?.candlestickPatterns) {
    validated.indicators.candlestickPatterns = validateCandlestickPatterns(
      validated.indicators.candlestickPatterns
    );
  }

  // Validate volume profile
  if (validated.volumeProfile) {
    validated.volumeProfile = validateVolumeProfile(validated.volumeProfile, currentPrice);
  }

  // Validate volatility
  if (validated.volatility && currentPrice) {
    validated.volatility = validateVolatility(validated.volatility, currentPrice);
  }

  // Validate fair value gaps
  if (validated.fairValueGaps) {
    validated.fairValueGaps = validateFairValueGaps(validated.fairValueGaps);
  }

  // Validate market structure
  if (validated.marketStructure) {
    validated.marketStructure = validateMarketStructure(validated.marketStructure);
  }

  // Validate liquidity zones
  if (validated.liquidityZones) {
    validated.liquidityZones = validateLiquidityZones(validated.liquidityZones);
  }

  // Validate divergences
  if (validated.divergences) {
    validated.divergences = validateDivergences(validated.divergences);
  }

  return validated;
}

export default {
  validateCandlestickPatterns,
  validateVolumeProfile,
  validateVolatility,
  validateFairValueGaps,
  validateMarketStructure,
  validateLiquidityZones,
  validateDivergences,
  validateTimeframeAnalysis
};
