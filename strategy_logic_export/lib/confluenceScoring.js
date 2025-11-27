/**
 * Confluence Scoring Module
 * 
 * Calculates multi-factor confidence scores for trade setups
 */

/**
 * Calculate confluence scores for a timeframe
 * @param {Object} tfData - Timeframe data with all indicators
 * @returns {Object} Confluence scores (0-1 scale)
 */
export function calculateConfluence(tfData) {
  const scores = {
    trendScore: 0,
    stochScore: 0,
    structureScore: 0,
    maScore: 0,
    vwapScore: 0
  };

  // 1. Trend Score (based on trend clarity and EMA alignment)
  if (tfData.trend) {
    if (tfData.trend === 'UPTREND' || tfData.trend === 'DOWNTREND') {
      scores.trendScore = 0.8;
      
      // Bonus if price is on correct side of EMAs
      if (tfData.candle && tfData.ema21) {
        const priceVsEma21 = tfData.candle.range.close > tfData.ema21;
        if ((tfData.trend === 'UPTREND' && priceVsEma21) ||
            (tfData.trend === 'DOWNTREND' && !priceVsEma21)) {
          scores.trendScore = 1.0;
        }
      }
    } else if (tfData.trend === 'FLAT') {
      scores.trendScore = 0.3;
    }
  }

  // 2. Stoch Score (based on position and condition)
  if (tfData.stoch) {
    const { k, condition } = tfData.stoch;
    
    // Perfect zones: oversold in uptrend, overbought in downtrend
    if (condition === 'OVERSOLD' && tfData.trend === 'UPTREND') {
      scores.stochScore = 1.0;
    } else if (condition === 'OVERBOUGHT' && tfData.trend === 'DOWNTREND') {
      scores.stochScore = 1.0;
    } else if (condition === 'BULLISH' && tfData.trend === 'UPTREND') {
      scores.stochScore = 0.7;
    } else if (condition === 'BEARISH' && tfData.trend === 'DOWNTREND') {
      scores.stochScore = 0.7;
    } else if (condition === 'NEUTRAL') {
      scores.stochScore = 0.4;
    } else {
      // Stoch not aligned with trend
      scores.stochScore = 0.2;
    }
  }

  // 3. Structure Score (based on pullback state and swing levels)
  if (tfData.pullback) {
    const { state } = tfData.pullback;
    
    if (state === 'ENTRY_ZONE') {
      scores.structureScore = 1.0;
    } else if (state === 'RETRACING') {
      scores.structureScore = 0.7;
    } else if (state === 'OVEREXTENDED') {
      scores.structureScore = 0.3;
    } else {
      scores.structureScore = 0.5;
    }
    
    // Bonus for price action confirmation
    if (tfData.priceAction) {
      if (tfData.priceAction.rejectionUp || tfData.priceAction.rejectionDown) {
        scores.structureScore = Math.min(1.0, scores.structureScore + 0.2);
      }
      if (tfData.priceAction.engulfingBull || tfData.priceAction.engulfingBear) {
        scores.structureScore = Math.min(1.0, scores.structureScore + 0.15);
      }
    }
  }

  // 4. MA Score (based on MA stack alignment)
  if (tfData.maStructure) {
    if (tfData.maStructure.bullStack) {
      scores.maScore = 1.0;
    } else if (tfData.maStructure.bearStack) {
      scores.maScore = 1.0;
    } else if (tfData.maStructure.flatStack) {
      scores.maScore = 0.2;
    } else {
      scores.maScore = 0.5;
    }
  } else {
    // If no MA structure, use trend as proxy
    scores.maScore = scores.trendScore * 0.8;
  }

  // 5. VWAP Score (if available)
  if (tfData.vwap && tfData.vwapPositioning) {
    const { above, below, atVwap } = tfData.vwap;
    const { trappedLongsLikely, trappedShortsLikely } = tfData.vwapPositioning;
    
    // Score based on VWAP positioning and trapped traders
    if (trappedShortsLikely && tfData.trend === 'UPTREND') {
      scores.vwapScore = 0.9;
    } else if (trappedLongsLikely && tfData.trend === 'DOWNTREND') {
      scores.vwapScore = 0.9;
    } else if (above && tfData.trend === 'UPTREND') {
      scores.vwapScore = 0.7;
    } else if (below && tfData.trend === 'DOWNTREND') {
      scores.vwapScore = 0.7;
    } else if (atVwap) {
      scores.vwapScore = 0.5; // At decision point
    } else {
      scores.vwapScore = 0.3; // Against positioning
    }
  } else {
    // No VWAP data, use neutral score
    scores.vwapScore = 0.5;
  }

  // Round all scores to 2 decimal places
  for (const key in scores) {
    scores[key] = parseFloat(scores[key].toFixed(2));
  }

  return scores;
}

/**
 * Calculate overall confluence score (weighted average)
 * @param {Object} scores - Individual confluence scores
 * @returns {Number} Overall score (0-1)
 */
export function calculateOverallConfluence(scores) {
  const weights = {
    trendScore: 0.30,      // 30% - most important
    stochScore: 0.20,      // 20%
    structureScore: 0.25,  // 25%
    maScore: 0.15,         // 15%
    vwapScore: 0.10        // 10%
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    if (scores[key] !== undefined) {
      weightedSum += scores[key] * weight;
      totalWeight += weight;
    }
  }

  return totalWeight > 0 ? parseFloat((weightedSum / totalWeight).toFixed(2)) : 0;
}

