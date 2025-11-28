/**
 * Multi-Timeframe Trading Strategy Engine
 * Implements flexible trading system with HTF bias scoring
 * Supports: 4H Trend Play, 1H Scalp, Swing, and Micro-Scalp
 */

import * as indicators from './indicators.js';

/**
 * Compute Higher Timeframe Bias from 4H + 1H
 * Replaces hard 4H FLAT gate with weighted scoring system
 * @param {Object} timeframes - All timeframe data
 * @returns {Object} HTF bias { direction, confidence, source }
 */
function computeHTFBias(timeframes) {
  const tf4h = timeframes['4h'];
  const tf1h = timeframes['1h'];

  if (!tf4h || !tf1h) {
    return { direction: 'neutral', confidence: 0, source: 'none' };
  }

  let longScore = 0;
  let shortScore = 0;

  // 4H trend (weighted higher)
  if (tf4h.indicators?.analysis?.trend === 'UPTREND') longScore += 2;
  if (tf4h.indicators?.analysis?.trend === 'DOWNTREND') shortScore += 2;

  // 1H trend
  if (tf1h.indicators?.analysis?.trend === 'UPTREND') longScore += 1;
  if (tf1h.indicators?.analysis?.trend === 'DOWNTREND') shortScore += 1;

  // Stoch conditions (4H + 1H)
  const stochs = [
    tf4h.indicators?.stochRSI?.condition,
    tf1h.indicators?.stochRSI?.condition
  ];
  
  for (const condition of stochs) {
    if (condition === 'BULLISH' || condition === 'OVERSOLD') longScore += 0.5;
    if (condition === 'BEARISH' || condition === 'OVERBOUGHT') shortScore += 0.5;
  }

  // Convert scores to bias
  if (longScore === 0 && shortScore === 0) {
    return { direction: 'neutral', confidence: 0, source: 'none' };
  }

  // Handle ties - prefer trending timeframe over stoch
  if (longScore === shortScore && longScore > 0) {
    // Check actual trends for tie-breaker
    const trend4h = tf4h.indicators?.analysis?.trend;
    const trend1h = tf1h.indicators?.analysis?.trend;
    
    if (trend1h === 'UPTREND') {
      return { direction: 'long', confidence: 60, source: '1h' };
    } else if (trend1h === 'DOWNTREND') {
      return { direction: 'short', confidence: 60, source: '1h' };
    } else if (trend4h === 'UPTREND') {
      return { direction: 'long', confidence: 50, source: '4h' };
    } else if (trend4h === 'DOWNTREND') {
      return { direction: 'short', confidence: 50, source: '4h' };
    }
    // True tie - mixed signals
    return { direction: 'neutral', confidence: 0, source: 'mixed' };
  }

  if (longScore > shortScore) {
    const conf = Math.min(100, Math.round((longScore / (longScore + shortScore)) * 100));
    return { 
      direction: 'long', 
      confidence: conf, 
      source: tf4h.indicators?.analysis?.trend !== 'FLAT' ? '4h' : '1h' 
    };
  } else if (shortScore > longScore) {
    const conf = Math.min(100, Math.round((shortScore / (longScore + shortScore)) * 100));
    return { 
      direction: 'short', 
      confidence: conf, 
      source: tf4h.indicators?.analysis?.trend !== 'FLAT' ? '4h' : '1h' 
    };
  } else {
    return { direction: 'neutral', confidence: 0, source: 'mixed' };
  }
}

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
  
  // Compute HTF Bias for Swing
  const htfBias = computeHTFBias(multiTimeframeData);
  
  // Build swing signal
  return {
    valid: true,
    direction: direction,
    setupType: 'Swing',
    selectedStrategy: 'SWING',
    strategiesChecked: ['SWING'],
    confidence: confidence / 100, // Convert to 0-1 scale
    reason: reason,
    reason_summary: reason,
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
    invalidation: {
      level: parseFloat(invalidationLevel.toFixed(2)),
      description: direction === 'long' ? 
        `Close below $${invalidationLevel.toFixed(2)}. HTF invalidation (3D/1D swing level)` :
        `Close above $${invalidationLevel.toFixed(2)}. HTF invalidation (3D/1D swing level)`
    },
    confluence: {
      trendAlignment: `${trend3d} on 3D, ${trend1d} on 1D, ${trend4h} on 4H`,
      stochMomentum: `3D: ${stoch3d.condition}, 1D: ${stoch1d.condition}`,
      pullbackState: `3D: ${pullback3d.state}, 1D: ${pullback1d.state}`,
      liquidityZones: `3D: ${pullback3d.distanceFrom21EMA.toFixed(2)}%, 1D: ${pullback1d.distanceFrom21EMA.toFixed(2)}%`,
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },
    conditionsRequired: [
      '✓ 3D stoch oversold/overbought pivot',
      '✓ 1D reclaim/rejection of key level',
      '✓ 4H trend supportive (not FLAT)',
      '✓ Price in ENTRY_ZONE on 15m/5m',
      '✓ HTF structure confirms'
    ],
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString(),
    htfBias: htfBias
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
      // Return swing signal directly (already includes htfBias)
      return {
        ...swingSignal,
        symbol,
        setupType: 'Swing',
        ema21: ema21,
        ema200: ema200,
        // Include trend/stoch for consistency
        trend: {
          '4h': trend4h.toLowerCase(),
          '1h': tf1h?.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
          '15m': tf15m?.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
          '5m': tf5m?.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
          '3d': analysis['3d']?.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
          '1d': analysis['1d']?.indicators?.analysis?.trend?.toLowerCase() || 'unknown'
        },
        stoch: {
          '4h': analyzeStochState(tf4h.indicators.stochRSI),
          '1h': tf1h ? analyzeStochState(tf1h.indicators.stochRSI) : null,
          '15m': tf15m ? analyzeStochState(tf15m.indicators.stochRSI) : null,
          '5m': tf5m ? analyzeStochState(tf5m.indicators.stochRSI) : null
        }
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
  
  // NEW: Compute HTF Bias instead of hard 4H gate
  const htfBias = computeHTFBias(analysis);
  
  // PRIORITY 2: Try 4H Trend Play (only if 4H is NOT FLAT)
  if (trend4h !== 'FLAT' && (setupType === '4h' || setupType === 'auto')) {
    // Continue with existing 4H trend logic below
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
    setupType: setupType,
    selectedStrategy: 'TREND_4H',
    strategiesChecked: ['SWING', 'TREND_4H'],
    entry_zone: {
      min: parseFloat(entryZone.min.toFixed(2)),
      max: parseFloat(entryZone.max.toFixed(2))
    },
    stop_loss: parseFloat(sltp.stopLoss.toFixed(2)),
    invalidation_level: parseFloat(sltp.invalidationLevel.toFixed(2)),
    targets: [
      parseFloat(sltp.targets[0].toFixed(2)),
      parseFloat(sltp.targets[1].toFixed(2))
    ],
    risk_reward: {
      tp1RR: rrTargets[0],
      tp2RR: rrTargets[1]
    },
    risk_amount: parseFloat(sltp.riskAmount.toFixed(2)),
    confidence: parseFloat(confidence.toFixed(2)),
    reason_summary: reasonSummary,
    invalidation: {
      level: parseFloat(sltp.invalidationLevel.toFixed(2)),
      description: '4H trend invalidation – break of recent swing level'
    },
    confluence: {
      trendAlignment: `${trend4h} on 4H, ${tf1h?.indicators?.analysis?.trend || 'N/A'} on 1H`,
      stochMomentum: tf4h.indicators?.stochRSI?.condition || 'N/A',
      pullbackState: pullbackState || 'N/A',
      liquidityZones: `${tf4h.indicators?.analysis?.pullback?.distanceFrom21EMA?.toFixed(2) || 'N/A'}% from 21 EMA`,
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },
    conditionsRequired: [
      '✓ 4H trend clear (UPTREND or DOWNTREND)',
      '✓ Price near 21 EMA on 4H (±2%)',
      '✓ Stoch aligned with trend direction',
      '✓ 1H confirmation (not breaking structure)',
      '✓ Clean 4H swing structure'
    ],
    trend: trendObj,
    stoch: stochObj,
    valid: true,
    timestamp: new Date().toISOString(),
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    ema21: parseFloat(ema21.toFixed(2)),
    ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null,
    htfBias: htfBias
  };
  } // End of 4H trend play
  
  // PRIORITY 3: Try 1H Scalp (works even when 4H is FLAT)
  if ((setupType === 'Scalp' || setupType === 'auto') && tf1h && tf15m) {
    const trend1h = tf1h.indicators?.analysis?.trend;
    const dist1h = tf1h.indicators?.analysis?.distanceFrom21EMA;
    const dist15m = tf15m.indicators?.analysis?.distanceFrom21EMA;
    const pullbackState1h = tf1h.indicators?.analysis?.pullbackState;
    const pullbackState15m = tf15m.indicators?.analysis?.pullbackState;
    
    // Need 1H trend (not FLAT)
    if (trend1h && trend1h !== 'FLAT') {
      const isLong = trend1h === 'UPTREND';
      const direction = isLong ? 'long' : 'short';
      
      // Check if price near 1H EMA21 and 15m EMA21
      const near1h = dist1h !== undefined && Math.abs(dist1h) <= 2.0;
      const near15m = dist15m !== undefined && Math.abs(dist15m) <= 1.5;
      
      // Also check pullback states are favorable
      const pullbackOk1h = pullbackState1h === 'ENTRY_ZONE' || pullbackState1h === 'RETRACING';
      const pullbackOk15m = pullbackState15m === 'ENTRY_ZONE' || pullbackState15m === 'RETRACING';
      
      if (near1h && near15m && pullbackOk1h && pullbackOk15m) {
        // Check 15m stoch alignment
        const stoch15m = tf15m.indicators?.stochRSI;
        const stochOk = stoch15m && (
          (isLong && (stoch15m.condition === 'BULLISH' || stoch15m.condition === 'OVERSOLD')) ||
          (!isLong && (stoch15m.condition === 'BEARISH' || stoch15m.condition === 'OVERBOUGHT'))
        );
        
        if (stochOk) {
          // Build 1H Scalp signal
          const ema21_1h = tf1h.indicators?.ema?.ema21 || currentPrice;
          const entryZone = calculateEntryZone(ema21_1h, direction);
          const entryMid = (entryZone.min + entryZone.max) / 2;
          
          const allStructures = {
            '3d': tf3d?.structure || { swingHigh: null, swingLow: null },
            '1d': tf1d?.structure || { swingHigh: null, swingLow: null },
            '4h': tf4h.structure,
            '15m': tf15m?.structure || { swingHigh: null, swingLow: null },
            '5m': tf5m?.structure || { swingHigh: null, swingLow: null }
          };
          
          const rrTargets = [1.5, 3.0]; // Scalp targets
          const sltp = calculateSLTP(entryMid, direction, allStructures, 'Scalp', rrTargets);
          
          // Confidence based on bias
          const baseConfidence = 60;
          const biasBonus = htfBias.direction === direction ? (htfBias.confidence * 0.2) : 0;
          const confidence = Math.min(85, baseConfidence + biasBonus);
          
          return {
            symbol,
            direction,
            setupType: 'Scalp',
            selectedStrategy: 'SCALP_1H',
            strategiesChecked: ['SWING', 'TREND_4H', 'SCALP_1H'],
            entry_zone: {
              min: parseFloat(entryZone.min.toFixed(2)),
              max: parseFloat(entryZone.max.toFixed(2))
            },
            stop_loss: parseFloat(sltp.stopLoss.toFixed(2)),
            invalidation_level: parseFloat(sltp.invalidationLevel.toFixed(2)),
            targets: [
              parseFloat(sltp.targets[0].toFixed(2)),
              parseFloat(sltp.targets[1].toFixed(2))
            ],
            risk_reward: {
              tp1RR: rrTargets[0],
              tp2RR: rrTargets[1]
            },
            risk_amount: parseFloat(sltp.riskAmount.toFixed(2)),
            confidence: parseFloat(confidence.toFixed(2)),
            reason_summary: `1H ${trend1h.toLowerCase()} scalp with 15m pullback and Stoch alignment (HTF bias: ${htfBias.direction}, ${htfBias.confidence}%)`,
            invalidation: {
              level: parseFloat(sltp.invalidationLevel.toFixed(2)),
              description: '1H scalp invalidation – loss of pullback structure on 15m/5m'
            },
            confluence: {
              trendAlignment: `${trend4h} on 4H, ${trend1h} on 1H`,
              stochMomentum: tf15m.indicators?.stochRSI?.condition || 'N/A',
              pullbackState: `1H: ${pullback1h?.state || 'N/A'}, 15m: ${pullback15m?.state || 'N/A'}`,
              liquidityZones: `1H: ${pullback1h?.distanceFrom21EMA?.toFixed(2) || 'N/A'}%, 15m: ${pullback15m?.distanceFrom21EMA?.toFixed(2) || 'N/A'}% from 21 EMA`,
              htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
            },
            conditionsRequired: [
              '✓ 1H trend clear (UPTREND or DOWNTREND)',
              '✓ 4H disregarded (scalp uses 1H bias)',
              '✓ Price near 21 EMA on 1H (±2%) and 15m (±1%)',
              '✓ 15m Stoch aligned with 1H trend',
              '✓ Clean 1H/15m pullback structure'
            ],
            trend: {
              '4h': trend4h.toLowerCase(),
              '1h': trend1h.toLowerCase(),
              '15m': tf15m.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
              '5m': tf5m?.indicators?.analysis?.trend?.toLowerCase() || 'unknown'
            },
            stoch: {
              '4h': analyzeStochState(tf4h.indicators.stochRSI),
              '1h': analyzeStochState(tf1h.indicators.stochRSI),
              '15m': analyzeStochState(tf15m.indicators.stochRSI),
              '5m': tf5m ? analyzeStochState(tf5m.indicators.stochRSI) : null
            },
            valid: true,
            timestamp: new Date().toISOString(),
            currentPrice: parseFloat(currentPrice.toFixed(2)),
            ema21: parseFloat(ema21_1h.toFixed(2)),
            ema200: tf1h.indicators?.ema?.ema200 ? parseFloat(tf1h.indicators.ema.ema200.toFixed(2)) : null,
            htfBias: htfBias
          };
        }
      }
    }
  }
  
  // PRIORITY 4: No clean setup on 4H or 1H
  return {
    symbol,
    direction: 'NO_TRADE',
    setupType: setupType || '4h',
    selectedStrategy: 'NO_TRADE',
    strategiesChecked: ['SWING', 'TREND_4H', 'SCALP_1H', 'MICRO_SCALP'],
    confidence: 0,
    reason_summary: `No clean 4H or 1H setup. 4H: ${trend4h}, 1H: ${tf1h?.indicators?.analysis?.trend || 'N/A'}. HTF bias: ${htfBias.direction} (${htfBias.confidence}% confidence)`,
    entry_zone: { min: null, max: null },
    stop_loss: null,
    invalidation_level: null,
    targets: [null, null],
    risk_reward: { tp1RR: null, tp2RR: null },
    risk_amount: null,
    invalidation: {
      level: null,
      description: 'No clear invalidation – awaiting setup formation'
    },
    confluence: {
      trendAlignment: `${trend4h} on 4H, ${tf1h?.indicators?.analysis?.trend || 'N/A'} on 1H`,
      stochMomentum: tf4h.indicators?.stochRSI?.condition || 'N/A',
      pullbackState: tf4h.indicators?.analysis?.pullbackState || 'N/A',
      liquidityZones: `${tf4h.indicators?.analysis?.pullback?.distanceFrom21EMA?.toFixed(2) || 'N/A'}% from 21 EMA`,
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },
    conditionsRequired: [
      `⚠ Awaiting clean setup`,
      `• 4H Trend Play: Needs 4H trending (not FLAT)`,
      `• 1H Scalp: Needs 1H trending + 15m pullback`,
      `• Micro-Scalp: Needs 1H trending + tight 15m/5m EMA confluence`
    ],
    trend: {
      '4h': trend4h.toLowerCase(),
      '1h': tf1h?.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
      '15m': tf15m?.indicators?.analysis?.trend?.toLowerCase() || 'unknown',
      '5m': tf5m?.indicators?.analysis?.trend?.toLowerCase() || 'unknown'
    },
    stoch: {
      '4h': analyzeStochState(tf4h.indicators.stochRSI),
      '1h': tf1h ? analyzeStochState(tf1h.indicators.stochRSI) : null,
      '15m': tf15m ? analyzeStochState(tf15m.indicators.stochRSI) : null,
      '5m': tf5m ? analyzeStochState(tf5m.indicators.stochRSI) : null
    },
    valid: false,
    timestamp: new Date().toISOString(),
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    ema21: parseFloat(ema21.toFixed(2)),
    ema200: ema200 ? parseFloat(ema200.toFixed(2)) : null,
    htfBias: htfBias
  };
}

/**
 * Evaluate Micro-Scalp Strategy
 * Independent LTF mean-reversion system (disregards 4H trend entirely)
 * Focuses on 1H/15m/5m alignment with tight EMA confluence
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


