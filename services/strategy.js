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
 * Evaluate 3D Swing Setup
 * TRUE swing trades are driven by 3D → 1D → 4H structure
 * @param {Object} multiTimeframeData - All timeframe data
 * @param {number} currentPrice - Current market price
 * @returns {Object|null} Swing signal or null
 */
function evaluateSwingSetup(multiTimeframeData, currentPrice) {
  const tf3d = multiTimeframeData['3d'];
  const tf1d = multiTimeframeData['1d'];
  const tf4h = multiTimeframeData['4h'];
  
  // Guard: Need all required timeframes
  if (!tf3d || !tf1d || !tf4h) {
    return null;
  }
  
  // Extract indicators
  const trend3d = tf3d.indicators?.trend;
  const trend1d = tf1d.indicators?.trend;
  const trend4h = tf4h.indicators?.trend;
  const pullback3d = tf3d.indicators?.pullback;
  const pullback1d = tf1d.indicators?.pullback;
  const pullback4h = tf4h.indicators?.pullback;
  const stoch3d = tf3d.indicators?.stoch;
  const stoch1d = tf1d.indicators?.stoch;
  const stoch4h = tf4h.indicators?.stoch;
  const ema21_4h = tf4h.indicators?.ema21;
  const ema21_1d = tf1d.indicators?.ema21;
  const swingLow3d = tf3d.indicators?.swingLow;
  const swingLow1d = tf1d.indicators?.swingLow;
  const swingHigh3d = tf3d.indicators?.swingHigh;
  const swingHigh1d = tf1d.indicators?.swingHigh;
  
  // Guard: Need all data points
  if (!trend3d || !trend1d || !trend4h || !pullback3d || !pullback1d || !pullback4h ||
      !stoch3d || !stoch1d || !stoch4h || !ema21_4h || !ema21_1d || !currentPrice) {
    return null;
  }
  
  // 1) GATEKEEPERS — WHEN SWING IS EVEN ALLOWED
  // 4H trend must NOT be FLAT for swing trades
  if (trend4h === 'FLAT') {
    return null;
  }
  
  // 3D trend must NOT be FLAT
  if (trend3d === 'FLAT') {
    return null;
  }
  
  // 1D trend must be either UPTREND or DOWNTREND
  if (trend1d === 'FLAT') {
    return null;
  }
  
  // 3D pullback must be OVEREXTENDED or RETRACING
  if (pullback3d.state !== 'OVEREXTENDED' && pullback3d.state !== 'RETRACING') {
    return null;
  }
  
  // 1D pullback must be RETRACING or ENTRY_ZONE
  if (pullback1d.state !== 'RETRACING' && pullback1d.state !== 'ENTRY_ZONE') {
    return null;
  }
  
  // 2) LONG SWING CONDITIONS
  let direction = null;
  let reclaimLevel = null;
  let reason = '';
  
  // Check for LONG swing setup
  const longConditions = {
    // HTF Direction: 3D bullish or flat leaning bullish
    htf3d: trend3d === 'UPTREND' || 
           (trend3d === 'FLAT' && (stoch3d.condition === 'BULLISH' || stoch3d.condition === 'OVERSOLD')),
    
    // 1D trending down BUT with bullish pivot signs
    htf1d: trend1d === 'DOWNTREND' && 
           (stoch1d.condition === 'BULLISH' || stoch1d.k < 25),
    
    // HTF Pullback: 3D overextended below 21EMA
    pullback3d: pullback3d.state === 'OVEREXTENDED' && 
                (pullback3d.distanceFrom21EMA < -8 || pullback3d.distanceFrom21EMA > -15),
    
    // 1D pullback
    pullback1d: pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE',
    
    // Price near 1D EMA21 but not nuking below 1D swing low
    pricePosition: currentPrice >= (swingLow1d || ema21_1d * 0.90) && 
                   currentPrice <= ema21_1d * 1.02,
    
    // 4H Confirmation
    conf4h: (trend4h === 'UPTREND' || (trend4h === 'FLAT' && stoch4h.condition === 'BULLISH')) &&
            (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE') &&
            Math.abs(currentPrice - ema21_4h) / currentPrice <= 0.01 // within ±1%
  };
  
  const allLongConditions = Object.values(longConditions).every(v => v);
  
  if (allLongConditions) {
    direction = 'long';
    // Reclaim level = mid between 1D swing low and 1D EMA21
    const swingLowToUse = swingLow1d || ema21_1d * 0.95;
    reclaimLevel = (swingLowToUse + ema21_1d) / 2;
    reason = '3D oversold pivot + 1D reclaim + 4H confirmation';
  }
  
  // 3) SHORT SWING CONDITIONS (MIRROR)
  if (!direction) {
    const shortConditions = {
      // HTF Direction: 3D bearish or flat leaning bearish
      htf3d: trend3d === 'DOWNTREND' || 
             (trend3d === 'FLAT' && (stoch3d.condition === 'BEARISH' || stoch3d.condition === 'OVERBOUGHT')),
      
      // 1D trending up BUT with bearish rejection signs
      htf1d: trend1d === 'UPTREND' && 
             (stoch1d.condition === 'BEARISH' || stoch1d.k > 75),
      
      // HTF Pullback: 3D overextended above 21EMA
      pullback3d: pullback3d.state === 'OVEREXTENDED' && 
                  (pullback3d.distanceFrom21EMA > 8 || pullback3d.distanceFrom21EMA < 15),
      
      // 1D pullback
      pullback1d: pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE',
      
      // Price near 1D EMA21 but not blowing past 1D swing high
      pricePosition: currentPrice <= (swingHigh1d || ema21_1d * 1.10) && 
                     currentPrice >= ema21_1d * 0.98,
      
      // 4H Confirmation
      conf4h: (trend4h === 'DOWNTREND' || (trend4h === 'FLAT' && stoch4h.condition === 'BEARISH')) &&
              (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE') &&
              Math.abs(currentPrice - ema21_4h) / currentPrice <= 0.01 // within ±1%
    };
    
    const allShortConditions = Object.values(shortConditions).every(v => v);
    
    if (allShortConditions) {
      direction = 'short';
      // Reclaim level = mid between 1D swing high and 1D EMA21
      const swingHighToUse = swingHigh1d || ema21_1d * 1.05;
      reclaimLevel = (swingHighToUse + ema21_1d) / 2;
      reason = '3D overbought rejection + 1D distribution + 4H confirmation';
    }
  }
  
  // If no valid direction, return null
  if (!direction || !reclaimLevel) {
    return null;
  }
  
  // 4) SWING STOP LOSS & TARGETS
  let stopLoss, invalidationLevel;
  
  if (direction === 'long') {
    // SL = min of 3D and 1D swing lows
    const sl3d = swingLow3d || (ema21_1d * 0.90);
    const sl1d = swingLow1d || (ema21_1d * 0.92);
    stopLoss = Math.min(sl3d, sl1d);
    invalidationLevel = stopLoss;
  } else {
    // SL = max of 3D and 1D swing highs
    const sh3d = swingHigh3d || (ema21_1d * 1.10);
    const sh1d = swingHigh1d || (ema21_1d * 1.08);
    stopLoss = Math.max(sh3d, sh1d);
    invalidationLevel = stopLoss;
  }
  
  // Entry zone: ±0.5% around reclaim level
  const entryMin = reclaimLevel * 0.995;
  const entryMax = reclaimLevel * 1.005;
  const midEntry = (entryMin + entryMax) / 2;
  
  // Risk (R)
  const R = Math.abs(midEntry - stopLoss);
  
  // Targets: 3R, 4R, 5R
  let tp1, tp2, tp3;
  if (direction === 'long') {
    tp1 = midEntry + (R * 3);
    tp2 = midEntry + (R * 4);
    tp3 = midEntry + (R * 5);
  } else {
    tp1 = midEntry - (R * 3);
    tp2 = midEntry - (R * 4);
    tp3 = midEntry - (R * 5);
  }
  
  // Confidence: 70-90 (3D + 1D confluence → higher confidence)
  let confidence = 70;
  // Boost for strong stoch alignment
  if (direction === 'long' && stoch3d.condition === 'OVERSOLD' && stoch1d.condition === 'BULLISH') {
    confidence += 10;
  } else if (direction === 'short' && stoch3d.condition === 'OVERBOUGHT' && stoch1d.condition === 'BEARISH') {
    confidence += 10;
  }
  // Boost for tight 4H entry
  if (Math.abs(currentPrice - ema21_4h) / currentPrice <= 0.005) { // within ±0.5%
    confidence += 5;
  }
  // Boost for strong 3D overextension
  const dist3d = Math.abs(pullback3d.distanceFrom21EMA);
  if (dist3d >= 10) {
    confidence += 5;
  }
  
  confidence = Math.min(confidence, 90);
  
  // Build swing signal
  return {
    valid: true,
    direction: direction,
    setupType: 'Swing',
    confidence: confidence / 100, // Convert to 0-1 scale
    reason: reason,
    entry_zone: {
      min: parseFloat(entryMin.toFixed(2)),
      max: parseFloat(entryMax.toFixed(2))
    },
    stop_loss: parseFloat(stopLoss.toFixed(2)),
    invalidation_level: parseFloat(invalidationLevel.toFixed(2)),
    targets: [
      parseFloat(tp1.toFixed(2)),
      parseFloat(tp2.toFixed(2)),
      parseFloat(tp3.toFixed(2))
    ],
    risk_reward: {
      tp1RR: 3.0,
      tp2RR: 4.0,
      tp3RR: 5.0
    },
    risk_amount: parseFloat(R.toFixed(2)),
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString()
  };
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
  
  // PRIORITY 1: Check for 3D Swing Setup (if setupType is 'Swing' OR auto-detect)
  if (setupType === 'Swing' || setupType === 'auto') {
    const swingSignal = evaluateSwingSetup(analysis, currentPrice);
    if (swingSignal && swingSignal.valid) {
      // Return swing signal directly
      return {
        ...swingSignal,
        symbol,
        setupType: 'Swing',
        ema21: ema21,
        ema200: ema200
      };
    }
    // If swing was requested but not valid, and setupType is explicitly 'Swing', return no trade
    if (setupType === 'Swing') {
      return {
        symbol,
        direction: 'flat',
        reason: '3D + 1D swing conditions not met',
        confidence: 0,
        valid: false,
        setupType: 'Swing'
      };
    }
  }
  
  // PRD 3.1: Only trade with 4h trend (blocks normal trades AND scalps)
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

/**
 * Evaluate 3D Swing Setup
 * TRUE swing trades driven by 3D → 1D → 4H structure with HTF invalidation
 * @param {Object} multiTimeframeData - All timeframe data
 * @returns {Object} Swing signal or null
 */
function evaluateSwingSetup(multiTimeframeData) {
  const tf3d = multiTimeframeData['3d'];
  const tf1d = multiTimeframeData['1d'];
  const tf4h = multiTimeframeData['4h'];
  
  // Guard: Need all required timeframes
  if (!tf3d || !tf1d || !tf4h) {
    return null;
  }
  
  // Extract indicators
  const trend3d = tf3d.indicators?.trend;
  const trend1d = tf1d.indicators?.trend;
  const trend4h = tf4h.indicators?.trend;
  const pullback3d = tf3d.indicators?.pullback;
  const pullback1d = tf1d.indicators?.pullback;
  const pullback4h = tf4h.indicators?.pullback;
  const stoch3d = tf3d.indicators?.stoch;
  const stoch1d = tf1d.indicators?.stoch;
  const stoch4h = tf4h.indicators?.stoch;
  const swingLow3d = tf3d.indicators?.swingLow;
  const swingHigh3d = tf3d.indicators?.swingHigh;
  const swingLow1d = tf1d.indicators?.swingLow;
  const swingHigh1d = tf1d.indicators?.swingHigh;
  const ema21_1d = tf1d.indicators?.ema21;
  const ema21_4h = tf4h.indicators?.ema21;
  const currentPrice = tf4h.indicators?.currentPrice || tf1d.indicators?.currentPrice;
  
  // Guard: Need all data points
  if (!trend3d || !trend1d || !trend4h || !pullback3d || !pullback1d || !pullback4h ||
      !stoch3d || !stoch1d || !stoch4h || !ema21_1d || !ema21_4h || !currentPrice) {
    return null;
  }
  
  // ===== GATEKEEPERS - WHEN SWING IS EVEN ALLOWED =====
  // 4H trend must NOT be FLAT
  if (trend4h === 'FLAT') {
    return null;
  }
  
  // 3D trend must NOT be FLAT
  if (trend3d === 'FLAT') {
    return null;
  }
  
  // 1D trend must be UPTREND or DOWNTREND
  if (trend1d === 'FLAT') {
    return null;
  }
  
  // 3D pullback must be OVEREXTENDED or RETRACING
  if (pullback3d.state !== 'OVEREXTENDED' && pullback3d.state !== 'RETRACING') {
    return null;
  }
  
  // 1D pullback must be RETRACING or ENTRY_ZONE
  if (pullback1d.state !== 'RETRACING' && pullback1d.state !== 'ENTRY_ZONE') {
    return null;
  }
  
  // ===== EVALUATE LONG SWING =====
  let direction = null;
  let entryZone = null;
  let stopLoss = null;
  let reason = '';
  let confidence = 0;
  
  // Check for LONG SWING
  const longSwingValid = (
    // 3D trend: UPTREND or FLAT with bullish stoch
    (trend3d === 'UPTREND' || (trend3d === 'FLAT' && (stoch3d.condition === 'BULLISH' || stoch3d.condition === 'OVERSOLD'))) &&
    
    // 1D trend: DOWNTREND BUT with bullish stoch or k curling up from <25
    (trend1d === 'DOWNTREND' && (stoch1d.condition === 'BULLISH' || (stoch1d.k && stoch1d.k < 25))) &&
    
    // 3D pullback: OVEREXTENDED (at least 8-15% below 21EMA)
    (pullback3d.state === 'OVEREXTENDED' && Math.abs(pullback3d.distanceFrom21EMA || 0) >= 8) &&
    
    // 1D pullback: RETRACING or ENTRY_ZONE
    (pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE') &&
    
    // 4H trend: UPTREND or FLAT with bullish stoch
    (trend4h === 'UPTREND' || (trend4h === 'FLAT' && stoch4h.condition === 'BULLISH')) &&
    
    // 4H pullback: RETRACING or ENTRY_ZONE
    (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE') &&
    
    // Price within ±1.0% of 4H EMA21
    (Math.abs((currentPrice - ema21_4h) / currentPrice * 100) <= 1.0)
  );
  
  if (longSwingValid && swingLow1d && ema21_1d) {
    direction = 'long';
    
    // Entry zone: reclaim level = mid between 1D swing low and 1D EMA21
    const reclaimLevel = (swingLow1d + ema21_1d) / 2;
    entryZone = {
      min: parseFloat((reclaimLevel * 0.995).toFixed(2)),
      max: parseFloat((reclaimLevel * 1.005).toFixed(2))
    };
    
    // Stop loss: prefer 3D swing low, fallback to 1D swing low
    if (swingLow3d && swingLow1d) {
      stopLoss = parseFloat(Math.min(swingLow3d, swingLow1d).toFixed(2));
    } else if (swingLow3d) {
      stopLoss = parseFloat(swingLow3d.toFixed(2));
    } else if (swingLow1d) {
      stopLoss = parseFloat(swingLow1d.toFixed(2));
    }
    
    reason = '3D + 1D oversold pivot with 4H confirmation. Price reclaiming 1D structure.';
    
    // Confidence: 70-90 based on 3D + 1D confluence
    confidence = 70;
    if (stoch3d.condition === 'OVERSOLD') confidence += 5;
    if (stoch1d.k && stoch1d.k < 20) confidence += 5;
    if (pullback4h.state === 'ENTRY_ZONE') confidence += 5;
    if (trend4h === 'UPTREND') confidence += 5;
  }
  
  // ===== EVALUATE SHORT SWING =====
  const shortSwingValid = (
    // 3D trend: DOWNTREND or FLAT with bearish stoch
    (trend3d === 'DOWNTREND' || (trend3d === 'FLAT' && (stoch3d.condition === 'BEARISH' || stoch3d.condition === 'OVERBOUGHT'))) &&
    
    // 1D trend: UPTREND BUT with bearish stoch or k curling down from >75
    (trend1d === 'UPTREND' && (stoch1d.condition === 'BEARISH' || (stoch1d.k && stoch1d.k > 75))) &&
    
    // 3D pullback: OVEREXTENDED (at least 8-15% above 21EMA)
    (pullback3d.state === 'OVEREXTENDED' && Math.abs(pullback3d.distanceFrom21EMA || 0) >= 8) &&
    
    // 1D pullback: RETRACING or ENTRY_ZONE
    (pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE') &&
    
    // 4H trend: DOWNTREND or FLAT with bearish stoch
    (trend4h === 'DOWNTREND' || (trend4h === 'FLAT' && stoch4h.condition === 'BEARISH')) &&
    
    // 4H pullback: RETRACING or ENTRY_ZONE
    (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE') &&
    
    // Price within ±1.0% of 4H EMA21
    (Math.abs((currentPrice - ema21_4h) / currentPrice * 100) <= 1.0)
  );
  
  if (shortSwingValid && swingHigh1d && ema21_1d) {
    direction = 'short';
    
    // Entry zone: reclaim level = mid between 1D swing high and 1D EMA21
    const reclaimLevel = (swingHigh1d + ema21_1d) / 2;
    entryZone = {
      min: parseFloat((reclaimLevel * 0.995).toFixed(2)),
      max: parseFloat((reclaimLevel * 1.005).toFixed(2))
    };
    
    // Stop loss: prefer 3D swing high, fallback to 1D swing high
    if (swingHigh3d && swingHigh1d) {
      stopLoss = parseFloat(Math.max(swingHigh3d, swingHigh1d).toFixed(2));
    } else if (swingHigh3d) {
      stopLoss = parseFloat(swingHigh3d.toFixed(2));
    } else if (swingHigh1d) {
      stopLoss = parseFloat(swingHigh1d.toFixed(2));
    }
    
    reason = '3D + 1D overbought rejection with 4H confirmation. Price rejecting 1D resistance.';
    
    // Confidence: 70-90 based on 3D + 1D confluence
    confidence = 70;
    if (stoch3d.condition === 'OVERBOUGHT') confidence += 5;
    if (stoch1d.k && stoch1d.k > 80) confidence += 5;
    if (pullback4h.state === 'ENTRY_ZONE') confidence += 5;
    if (trend4h === 'DOWNTREND') confidence += 5;
  }
  
  // If no valid direction, return null
  if (!direction || !entryZone || !stopLoss) {
    return null;
  }
  
  // Calculate R and targets
  const midEntry = (entryZone.min + entryZone.max) / 2;
  const R = Math.abs(midEntry - stopLoss);
  
  // Swing targets: 3R, 4R, 5R
  const targets = direction === 'long' ? {
    tp1: parseFloat((midEntry + (R * 3)).toFixed(2)),
    tp2: parseFloat((midEntry + (R * 4)).toFixed(2)),
    tp3: parseFloat((midEntry + (R * 5)).toFixed(2))
  } : {
    tp1: parseFloat((midEntry - (R * 3)).toFixed(2)),
    tp2: parseFloat((midEntry - (R * 4)).toFixed(2)),
    tp3: parseFloat((midEntry - (R * 5)).toFixed(2))
  };
  
  // Build signal
  return {
    valid: true,
    direction: direction,
    setupType: 'Swing',
    confidence: parseFloat((confidence / 100).toFixed(2)), // Normalize to 0-1
    entry_zone: entryZone,
    stop_loss: stopLoss,
    invalidation_level: stopLoss,
    targets: [targets.tp1, targets.tp2, targets.tp3],
    risk_reward: {
      tp1RR: 3.0,
      tp2RR: 4.0,
      tp3RR: 5.0
    },
    risk_amount: parseFloat(R.toFixed(2)),
    reason_summary: reason,
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString(),
    
    // HTF structure details for invalidation
    invalidation_description: direction === 'long' ? 
      `1D close below ${swingLow1d?.toFixed(2)} or 3D close below ${swingLow3d?.toFixed(2)}` :
      `1D close above ${swingHigh1d?.toFixed(2)} or 3D close above ${swingHigh3d?.toFixed(2)}`
  };
}

/**
 * Evaluate Micro-Scalp Override
 * Allows small mean-reversion trades even when 4H is FLAT, but only under strict LTF confluence
 * @param {Object} multiTimeframeData - All timeframe data
 * @returns {Object} Micro-scalp signal or null
 */
function evaluateMicroScalp(multiTimeframeData) {
  const tf1h = multiTimeframeData['1h'];
  const tf15m = multiTimeframeData['15m'];
  const tf5m = multiTimeframeData['5m'];
  
  // Base response structure
  const result = {
    eligible: false,
    signal: null
  };
  
  // Guard: Need all required timeframes
  if (!tf1h || !tf15m || !tf5m) {
    return result;
  }
  
  // Extract indicators
  const trend1h = tf1h.indicators?.trend;
  const pullback1h = tf1h.indicators?.pullback;
  const ema21_15m = tf15m.indicators?.ema21;
  const ema21_5m = tf5m.indicators?.ema21;
  const pullback15m = tf15m.indicators?.pullback;
  const pullback5m = tf5m.indicators?.pullback;
  const stoch15m = tf15m.indicators?.stoch;
  const stoch5m = tf5m.indicators?.stoch;
  const swingLow15m = tf15m.indicators?.swingLow;
  const swingLow5m = tf5m.indicators?.swingLow;
  const swingHigh15m = tf15m.indicators?.swingHigh;
  const swingHigh5m = tf5m.indicators?.swingHigh;
  const currentPrice = tf5m.indicators?.currentPrice || tf15m.indicators?.currentPrice;
  
  // Guard: Need all data points
  if (!trend1h || !pullback1h || !ema21_15m || !ema21_5m || !pullback15m || !pullback5m || 
      !stoch15m || !stoch5m || !currentPrice) {
    return result;
  }
  
  // 2.1 HIGH-TIMEFRAME GUARDRAILS
  // 1H must be trending (not FLAT)
  if (trend1h === 'FLAT') {
    return result;
  }
  
  // 1H pullback must be ENTRY_ZONE or RETRACING
  if (pullback1h.state !== 'ENTRY_ZONE' && pullback1h.state !== 'RETRACING') {
    return result;
  }
  
  // If we passed guardrails, micro-scalp is eligible
  result.eligible = true;
  
  // 2.2 LOWER TIMEFRAME CONFLUENCE (15m + 5m)
  let direction = null;
  let reason = '';
  
  // Check for LONG micro-scalp
  if (trend1h === 'UPTREND') {
    // Both 15m & 5m must be near EMA21 (within 0.25%)
    const dist15m = Math.abs(pullback15m.distanceFrom21EMA || 999);
    const dist5m = Math.abs(pullback5m.distanceFrom21EMA || 999);
    
    if (dist15m <= 0.25 && dist5m <= 0.25 &&
        (pullback15m.state === 'ENTRY_ZONE' || pullback15m.state === 'RETRACING') &&
        (pullback5m.state === 'ENTRY_ZONE' || pullback5m.state === 'RETRACING')) {
      
      // Check stoch conditions
      const k15m = stoch15m.k;
      const k5m = stoch5m.k;
      const cond15m = stoch15m.condition;
      const cond5m = stoch5m.condition;
      
      // Either oversold (<25) OR bullish momentum with k<40
      const stochValid = (
        (cond15m === 'OVERSOLD' || k15m < 25) && (cond5m === 'OVERSOLD' || k5m < 25)
      ) || (
        (cond15m === 'BULLISH' && k15m < 40) && (cond5m === 'BULLISH' && k5m < 40)
      );
      
      if (stochValid) {
        direction = 'long';
        reason = `1H uptrend, 15m/5m at EMA21 (${dist15m.toFixed(2)}%/${dist5m.toFixed(2)}%), stoch oversold/bullish momentum`;
      }
    }
  }
  
  // Check for SHORT micro-scalp
  if (trend1h === 'DOWNTREND') {
    const dist15m = Math.abs(pullback15m.distanceFrom21EMA || 999);
    const dist5m = Math.abs(pullback5m.distanceFrom21EMA || 999);
    
    if (dist15m <= 0.25 && dist5m <= 0.25 &&
        (pullback15m.state === 'ENTRY_ZONE' || pullback15m.state === 'RETRACING') &&
        (pullback5m.state === 'ENTRY_ZONE' || pullback5m.state === 'RETRACING')) {
      
      const k15m = stoch15m.k;
      const k5m = stoch5m.k;
      const cond15m = stoch15m.condition;
      const cond5m = stoch5m.condition;
      
      // Either overbought (>75) OR bearish momentum with k>60
      const stochValid = (
        (cond15m === 'OVERBOUGHT' || k15m > 75) && (cond5m === 'OVERBOUGHT' || k5m > 75)
      ) || (
        (cond15m === 'BEARISH' && k15m > 60) && (cond5m === 'BEARISH' && k5m > 60)
      );
      
      if (stochValid) {
        direction = 'short';
        reason = `1H downtrend, 15m/5m at EMA21 (${dist15m.toFixed(2)}%/${dist5m.toFixed(2)}%), stoch overbought/bearish momentum`;
      }
    }
  }
  
  // If no valid direction, return eligible but no signal
  if (!direction) {
    return result;
  }
  
  // 2.3 MICRO-SCALP SL/TP LOGIC
  let stopLoss, entry, invalidationLevel;
  
  if (direction === 'long') {
    // SL = min of 15m and 5m swing lows
    stopLoss = Math.min(swingLow15m || currentPrice * 0.95, swingLow5m || currentPrice * 0.95);
    invalidationLevel = stopLoss;
  } else {
    // SL = max of 15m and 5m swing highs
    stopLoss = Math.max(swingHigh15m || currentPrice * 1.05, swingHigh5m || currentPrice * 1.05);
    invalidationLevel = stopLoss;
  }
  
  // Entry = average of 15m & 5m EMA21
  entry = (ema21_15m + ema21_5m) / 2;
  
  // R = |entry - stopLoss|
  const R = Math.abs(entry - stopLoss);
  
  // Targets: TP1 = 1.0R, TP2 = 1.5R
  const tp1 = direction === 'long' ? entry + R : entry - R;
  const tp2 = direction === 'long' ? entry + (R * 1.5) : entry - (R * 1.5);
  
  // Entry zone: ±0.5% around entry
  const entryMin = entry * 0.995;
  const entryMax = entry * 1.005;
  
  // Confidence: 60-75 based on how tight confluence is
  const dist15m = Math.abs(pullback15m.distanceFrom21EMA || 0);
  const dist5m = Math.abs(pullback5m.distanceFrom21EMA || 0);
  const avgDist = (dist15m + dist5m) / 2;
  const confidence = Math.max(60, Math.min(75, 75 - (avgDist * 60))); // Tighter = higher confidence
  
  // Build signal
  result.signal = {
    valid: true,
    direction: direction,
    setupType: 'MicroScalp',
    confidence: parseFloat(confidence.toFixed(0)),
    entry: {
      min: parseFloat(entryMin.toFixed(2)),
      max: parseFloat(entryMax.toFixed(2))
    },
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    targets: {
      tp1: parseFloat(tp1.toFixed(2)),
      tp2: parseFloat(tp2.toFixed(2))
    },
    riskReward: {
      tp1RR: 1.0,
      tp2RR: 1.5
    },
    invalidation_level: parseFloat(invalidationLevel.toFixed(2)),
    invalidation_description: direction === 'long' ? 
      `5m close below ${invalidationLevel.toFixed(2)}` : 
      `5m close above ${invalidationLevel.toFixed(2)}`,
    reason: reason,
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString()
  };
  
  return result;
}

export default {
  evaluateStrategy,
  analyzeStochState,
  calculateConfidence,
  evaluateMicroScalp,
  evaluateSwingSetup
};


