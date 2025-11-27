/**
 * 4-Hour Trading Strategy Engine
 * Implements Bryan's set-and-forget 4h trading system
 * Based on PRD requirements for long/short setup validation
 */

import * as indicators from './indicators.js';

/**
 * Detect if Stochastic RSI is curling up or down
 * @param {Array<Object>} stochHistory - Array of {k, d} values
 * @returns {string} 'up', 'down', or 'flat'
 */
function detectStochCurl(stochHistory) {
  if (!stochHistory || stochHistory.length < 3) return 'flat';
  
  const recent = stochHistory.slice(-3);
  const k1 = recent[0].k;
  const k2 = recent[1].k;
  const k3 = recent[2].k;
  
  // Check if consistently rising or falling
  if (k3 > k2 && k2 > k1) return 'up';
  if (k3 < k2 && k2 < k1) return 'down';
  
  return 'flat';
}

/**
 * Analyze stochastic RSI state
 * @param {Object} stochRSI - Stoch RSI data with k, d, history
 * @returns {Object} Enhanced stoch state
 */
function analyzeStochState(stochRSI) {
  if (!stochRSI || !stochRSI.k || !stochRSI.d) {
    return {
      zone: 'unknown',
      direction: 'flat',
      curl: 'flat',
      alignment: false
    };
  }
  
  const { k, d, history } = stochRSI;
  
  // Determine zone
  let zone = 'mid';
  if (k > 80 && d > 80) zone = 'overbought';
  else if (k < 20 && d < 20) zone = 'oversold';
  
  // Determine direction
  let direction = 'flat';
  if (k > d) direction = 'bullish';
  else if (k < d) direction = 'bearish';
  
  // Detect curl
  const curl = detectStochCurl(history);
  
  // Check alignment (k and d moving same direction)
  const alignment = (k > d && curl === 'up') || (k < d && curl === 'down');
  
  return {
    zone,
    direction,
    curl,
    alignment,
    k,
    d
  };
}

/**
 * Calculate entry zone around 21 EMA
 * @param {number} ema21 - Current 21 EMA value
 * @param {string} direction - 'long' or 'short'
 * @returns {Object} Entry zone with min and max
 */
function calculateEntryZone(ema21, direction) {
  const buffer = 0.004; // 0.4% buffer as per PRD (±0.3-0.5%)
  
  if (direction === 'long') {
    // For longs: slight undercut allowed
    return {
      min: ema21 * (1 - buffer),
      max: ema21 * (1 + buffer * 0.5)
    };
  } else {
    // For shorts: slight overshoot allowed
    return {
      min: ema21 * (1 - buffer * 0.5),
      max: ema21 * (1 + buffer)
    };
  }
}

/**
 * Calculate stop loss and take profit levels
 * UPDATED: Now uses setupType-conditional stop loss logic per text file
 * - Swing: Uses HTF (3D/1D) invalidation levels
 * - Scalp: Uses LTF (5m/15m) structure
 * - 4H: Uses 4H swing levels
 * 
 * @param {number} entryPrice - Entry price (mid of zone)
 * @param {string} direction - 'long' or 'short'
 * @param {Object} allStructures - Structures from all timeframes { '3d': {...}, '1d': {...}, '4h': {...}, '15m': {...}, '5m': {...} }
 * @param {string} setupType - 'Swing', 'Scalp', or '4h'
 * @param {Array<number>} rrTargets - R:R multiples for TP1, TP2 [1.0, 2.0] or [3.0, 5.0]
 * @returns {Object} SL and TP levels
 */
function calculateSLTP(entryPrice, direction, allStructures, setupType = '4h', rrTargets = [1.0, 2.0]) {
  const buffer = 0.003; // 0.3% buffer
  
  let stopLoss, structure;
  
  // Select appropriate timeframe structure based on setup type
  if (setupType === 'Swing') {
    // Swing trades: Use HTF invalidation (3D or 1D)
    structure = allStructures['3d'] || allStructures['1d'] || allStructures['4h'];
  } else if (setupType === 'Scalp') {
    // Scalp trades: Use LTF invalidation (5m or 15m)
    structure = allStructures['5m'] || allStructures['15m'] || allStructures['4h'];
  } else {
    // 4H trades: Use 4H structure
    structure = allStructures['4h'] || allStructures['1d'];
  }
  
  const { swingHigh, swingLow } = structure;
  
  if (direction === 'long') {
    // SL below swing low
    stopLoss = swingLow ? swingLow * (1 - buffer) : entryPrice * 0.97;
    const risk = entryPrice - stopLoss;
    
    // TP based on R:R targets from template
    const tp1 = entryPrice + (risk * rrTargets[0]);
    const tp2 = entryPrice + (risk * rrTargets[1]);
    
    return {
      stopLoss,
      targets: [tp1, tp2],
      riskAmount: risk,
      setupType: setupType,
      invalidationLevel: swingLow || (entryPrice * 0.97)
    };
    
  } else { // short
    // SL above swing high
    stopLoss = swingHigh ? swingHigh * (1 + buffer) : entryPrice * 1.03;
    const risk = stopLoss - entryPrice;
    
    // TP based on R:R targets from template
    const tp1 = entryPrice - (risk * rrTargets[0]);
    const tp2 = entryPrice - (risk * rrTargets[1]);
    
    return {
      stopLoss,
      targets: [tp1, tp2],
      riskAmount: risk,
      setupType: setupType,
      invalidationLevel: swingHigh || (entryPrice * 1.03)
    };
  }
}

/**
 * Calculate confidence score (0-1)
 * Based on PRD Section 7 confidence scoring
 * @param {Object} analysis - Multi-timeframe analysis
 * @param {string} direction - 'long' or 'short'
 * @returns {number} Confidence score 0-1
 */
function calculateConfidence(analysis, direction) {
  let score = 0;
  
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  const tf15m = analysis['15m'];
  const tf5m = analysis['5m'];
  
  if (!tf4h || !tf1h) return 0;
  
  // 1. 4h trend alignment (0-0.4)
  const trend4h = tf4h.indicators.analysis.trend;
  if (direction === 'long' && trend4h === 'UPTREND') score += 0.4;
  else if (direction === 'short' && trend4h === 'DOWNTREND') score += 0.4;
  else if (trend4h === 'FLAT') score += 0.1; // Partial credit
  
  // 2. 1h confirmation (0-0.2)
  const trend1h = tf1h.indicators.analysis.trend;
  if (direction === 'long' && trend1h === 'UPTREND') score += 0.2;
  else if (direction === 'short' && trend1h === 'DOWNTREND') score += 0.2;
  else if (trend1h === 'FLAT') score += 0.1;
  
  // 3. Stoch alignment (0-0.2)
  if (tf15m && tf5m) {
    const stoch15m = analyzeStochState(tf15m.indicators.stochRSI);
    const stoch5m = analyzeStochState(tf5m.indicators.stochRSI);
    
    if (direction === 'long') {
      if (stoch15m.curl === 'up' && stoch5m.curl === 'up') score += 0.2;
      else if (stoch15m.curl === 'up' || stoch5m.curl === 'up') score += 0.1;
    } else if (direction === 'short') {
      if (stoch15m.curl === 'down' && stoch5m.curl === 'down') score += 0.2;
      else if (stoch15m.curl === 'down' || stoch5m.curl === 'down') score += 0.1;
    }
  }
  
  // 4. Structure confluence (0-0.1)
  if (tf4h.structure.swingHigh && tf4h.structure.swingLow) {
    const price = tf4h.indicators.price.current;
    const { swingHigh, swingLow } = tf4h.structure;
    const range = swingHigh - swingLow;
    const position = (price - swingLow) / range;
    
    // Good structure position for the trade direction
    if (direction === 'long' && position < 0.5) score += 0.1; // Price in lower half
    else if (direction === 'short' && position > 0.5) score += 0.1; // Price in upper half
    else score += 0.05; // Partial credit
  }
  
  // 5. MA confluence (0-0.1)
  const pullbackState = tf4h.indicators.analysis.pullbackState;
  if (pullbackState === 'ENTRY_ZONE') score += 0.1; // Perfect entry zone
  else if (pullbackState === 'RETRACING') score += 0.05; // Approaching
  
  return Math.min(score, 1.0); // Cap at 1.0
}

/**
 * Build reason summary string
 * @param {Object} analysis - Multi-timeframe analysis
 * @param {string} direction - Trade direction
 * @param {number} confidence - Confidence score
 * @returns {string} Human-readable summary
 */
function buildReasonSummary(analysis, direction, confidence) {
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  
  if (!tf4h) return 'Insufficient data';
  
  const trend4h = tf4h.indicators.analysis.trend.toLowerCase();
  const trend1h = tf1h ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown';
  const pullback = tf4h.indicators.analysis.pullbackState.toLowerCase().replace('_', ' ');
  
  let summary = `4h ${trend4h}`;
  
  if (tf1h) {
    if (trend1h === trend4h.split('trend')[0]) {
      summary += `, 1h agrees`;
    } else {
      summary += `, 1h ${trend1h}`;
    }
  }
  
  summary += `, price ${pullback}`;
  
  if (analysis['15m'] && analysis['5m']) {
    const stoch15m = analyzeStochState(analysis['15m'].indicators.stochRSI);
    const stoch5m = analyzeStochState(analysis['5m'].indicators.stochRSI);
    
    if (stoch15m.curl !== 'flat' || stoch5m.curl !== 'flat') {
      summary += `, lower TF stoch ${stoch15m.curl}/${stoch5m.curl}`;
    }
  }
  
  if (confidence >= 0.75) {
    summary += ' ✅ HIGH CONFIDENCE';
  } else if (confidence < 0.55) {
    summary += ' ⚠️ LOW CONFIDENCE';
  }
  
  return summary;
}

/**
 * Main strategy evaluation function
 * Implements PRD Sections 3.1, 3.2, 3.3, 3.4
 * UPDATED: Now accepts setupType for conditional stop loss logic
 * @param {string} symbol - Trading symbol
 * @param {Object} multiTimeframeData - Analysis for all timeframes
 * @param {string} setupType - 'Swing', 'Scalp', or '4h' (default '4h')
 * @returns {Object} Trade signal object
 */
export function evaluateStrategy(symbol, multiTimeframeData, setupType = '4h') {
  const analysis = multiTimeframeData;
  const tf3d = analysis['3d'];
  const tf1d = analysis['1d'];
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  const tf15m = analysis['15m'];
  const tf5m = analysis['5m'];
  const tf1m = analysis['1m'];
  
  // Must have at least 4h data
  if (!tf4h || !tf4h.indicators) {
    return {
      symbol,
      direction: 'flat',
      reason: 'Insufficient 4h data',
      confidence: 0,
      valid: false
    };
  }
  
  const trend4h = tf4h.indicators.analysis.trend;
  const currentPrice = tf4h.indicators.price.current;
  const ema21 = tf4h.indicators.ema.ema21;
  const ema200 = tf4h.indicators.ema.ema200;
  const pullbackState = tf4h.indicators.analysis.pullbackState;
  
  // PRD 3.1: Only trade with 4h trend
  if (trend4h === 'FLAT') {
    return {
      symbol,
      direction: 'flat',
      reason: '4h trend is flat - no trade',
      confidence: 0,
      valid: false,
      trend: {
        '4h': 'flat',
        '1h': tf1h ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown'
      }
    };
  }
  
  let direction = null;
  let setupValid = false;
  const invalidationReasons = [];
  
  // PRD 3.2: Long Setup Requirements
  if (trend4h === 'UPTREND') {
    direction = 'long';
    setupValid = true;
    
    // Check: Price retracing toward 21 EMA
    if (pullbackState === 'OVEREXTENDED') {
      invalidationReasons.push('Price too far from 21 EMA');
      setupValid = false;
    }
    
    // Check: 1h structure not breaking down
    if (tf1h && tf1h.indicators.analysis.trend === 'DOWNTREND') {
      invalidationReasons.push('1h breaking down');
      setupValid = false;
    }
    
    // Check: 15m + 5m stoch curling up (if available)
    if (tf15m && tf5m) {
      const stoch15m = analyzeStochState(tf15m.indicators.stochRSI);
      const stoch5m = analyzeStochState(tf5m.indicators.stochRSI);
      
      if (stoch15m.curl === 'down' && stoch5m.curl === 'down') {
        invalidationReasons.push('Lower TF stoch bearish');
        setupValid = false;
      }
    }
  }
  
  // PRD 3.3: Short Setup Requirements
  else if (trend4h === 'DOWNTREND') {
    direction = 'short';
    setupValid = true;
    
    // Check: Price retracing toward 21 EMA
    if (pullbackState === 'OVEREXTENDED') {
      invalidationReasons.push('Price too far from 21 EMA');
      setupValid = false;
    }
    
    // Check: 1h structure showing lower highs
    if (tf1h && tf1h.indicators.analysis.trend === 'UPTREND') {
      invalidationReasons.push('1h breaking up');
      setupValid = false;
    }
    
    // Check: 15m + 5m stoch curling down (if available)
    if (tf15m && tf5m) {
      const stoch15m = analyzeStochState(tf15m.indicators.stochRSI);
      const stoch5m = analyzeStochState(tf5m.indicators.stochRSI);
      
      if (stoch15m.curl === 'up' && stoch5m.curl === 'up') {
        invalidationReasons.push('Lower TF stoch bullish');
        setupValid = false;
      }
    }
  }
  
  if (!setupValid || !direction) {
    return {
      symbol,
      direction: 'flat',
      reason: invalidationReasons.join('; ') || 'Setup requirements not met',
      confidence: 0,
      valid: false,
      trend: {
        '4h': trend4h.toLowerCase(),
        '1h': tf1h ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown'
      }
    };
  }
  
  // Gather all timeframe structures for conditional stop loss
  const allStructures = {
    '3d': tf3d?.structure || { swingHigh: null, swingLow: null },
    '1d': tf1d?.structure || { swingHigh: null, swingLow: null },
    '4h': tf4h.structure,
    '15m': tf15m?.structure || { swingHigh: null, swingLow: null },
    '5m': tf5m?.structure || { swingHigh: null, swingLow: null }
  };
  
  // Determine R:R targets based on setup type
  const rrTargets = setupType === 'Swing' ? [3.0, 5.0] : 
                    setupType === 'Scalp' ? [1.5, 2.5] : 
                    [1.0, 2.0];
  
  // Calculate entry zone, SL, TP with setupType-conditional logic
  const entryZone = calculateEntryZone(ema21, direction);
  const entryMid = (entryZone.min + entryZone.max) / 2;
  const sltp = calculateSLTP(entryMid, direction, allStructures, setupType, rrTargets);
  
  // Calculate confidence score
  const confidence = calculateConfidence(analysis, direction);
  
  // Build reason summary
  const reasonSummary = buildReasonSummary(analysis, direction, confidence);
  
  // Build trend object
  const trendObj = {
    '4h': trend4h.toLowerCase(),
    '1h': tf1h ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown',
    '15m': tf15m ? tf15m.indicators.analysis.trend.toLowerCase() : 'unknown',
    '5m': tf5m ? tf5m.indicators.analysis.trend.toLowerCase() : 'unknown'
  };
  
  // Build stoch object
  const stochObj = {
    '4h': analyzeStochState(tf4h.indicators.stochRSI),
    '1h': tf1h ? analyzeStochState(tf1h.indicators.stochRSI) : null,
    '15m': tf15m ? analyzeStochState(tf15m.indicators.stochRSI) : null,
    '5m': tf5m ? analyzeStochState(tf5m.indicators.stochRSI) : null
  };
  
  return {
    symbol,
    direction,
    setupType: setupType,  // Added: Type of setup (Swing, Scalp, 4h)
    entry_zone: {
      min: parseFloat(entryZone.min.toFixed(2)),
      max: parseFloat(entryZone.max.toFixed(2))
    },
    stop_loss: parseFloat(sltp.stopLoss.toFixed(2)),
    invalidation_level: parseFloat(sltp.invalidationLevel.toFixed(2)),  // Added: HTF/LTF invalidation
    targets: [
      parseFloat(sltp.targets[0].toFixed(2)),
      parseFloat(sltp.targets[1].toFixed(2))
    ],
    risk_reward: {
      tp1RR: rrTargets[0],
      tp2RR: rrTargets[1]
    },
    risk_amount: parseFloat(sltp.riskAmount.toFixed(2)),  // Added: Dollar risk per unit
    confidence: parseFloat(confidence.toFixed(2)),
    reason_summary: reasonSummary,
    trend: trendObj,
    stoch: stochObj,
    valid: true,
    timestamp: new Date().toISOString(),
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    ema21: parseFloat(ema21.toFixed(2)),
    ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null
  };
}

export default {
  evaluateStrategy,
  analyzeStochState,
  calculateConfidence
};


