/**
 * Multi-Timeframe Trading Strategy Engine
 * Implements flexible trading system with HTF bias scoring
 * Supports: 4H Trend Play, 1H Scalp, Swing, and Micro-Scalp
 * Includes AGGRESSIVE mode for looser requirements when STANDARD finds no trade
 */

import * as indicators from './indicators.js';

/**
 * Normalize trend value to consistent lowercase format
 * Converts: "UPTREND", "uptrend", "UP" → "uptrend"
 * Converts: "DOWNTREND", "downtrend", "DOWN" → "downtrend"
 * Everything else → "flat"
 * @param {string} trend - Raw trend value
 * @returns {string} Normalized trend: "uptrend" | "downtrend" | "flat"
 */
function normalizeTrend(trend) {
  if (!trend || typeof trend !== 'string') return 'flat';
  const lower = trend.toLowerCase().trim();
  if (lower.includes('up')) return 'uptrend';
  if (lower.includes('down')) return 'downtrend';
  return 'flat';
}

/**
 * Infer trend direction from price position relative to EMAs
 * Used when trend is "flat" but we need directional bias
 * @param {number} price - Current price
 * @param {number} ema21 - 21 EMA value
 * @param {number} ema200 - 200 EMA value (optional)
 * @returns {string} 'uptrend', 'downtrend', or 'flat'
 */
function inferTrendFromPrice(price, ema21, ema200 = null) {
  if (!price || !ema21) return 'flat';
  
  // If both EMAs available, use both for stronger signal
  if (ema200 !== null && ema200 !== undefined) {
    if (price > ema21 && price > ema200) return 'uptrend';
    if (price < ema21 && price < ema200) return 'downtrend';
  } else {
    // Only EMA21 available
    if (price > ema21) return 'uptrend';
    if (price < ema21) return 'downtrend';
  }
  
  return 'flat';
}

/**
 * INVARIANT VALIDATION: Validate strategy signal meets all requirements
 * If valid=true, ALL required fields must be present and logically consistent
 */
function validateStrategySignal(signal) {
  if (!signal) return false;
  
  // If valid=true, enforce strict requirements
  if (signal.valid === true) {
    // Entry zone must be valid
    if (!signal.entryZone || 
        signal.entryZone.min === null || 
        signal.entryZone.max === null ||
        isNaN(signal.entryZone.min) ||
        isNaN(signal.entryZone.max) ||
        signal.entryZone.min > signal.entryZone.max) {
      console.error('❌ Invalid signal: valid=true but entryZone invalid', signal);
      return false;
    }
    
    // Stop loss must be valid number
    if (signal.stopLoss === null || signal.stopLoss === undefined || isNaN(signal.stopLoss)) {
      console.error('❌ Invalid signal: valid=true but stopLoss invalid', signal);
      return false;
    }
    
    // Invalidation level must be valid
    if (signal.invalidationLevel === null || signal.invalidationLevel === undefined || isNaN(signal.invalidationLevel)) {
      console.error('❌ Invalid signal: valid=true but invalidationLevel invalid', signal);
      return false;
    }
    
    // At least one target must be present
    if (!signal.targets || signal.targets.length === 0 || 
        signal.targets[0] === null || signal.targets[0] === undefined || isNaN(signal.targets[0])) {
      console.error('❌ Invalid signal: valid=true but no valid targets', signal);
      return false;
    }
    
    // Direction must not be NO_TRADE
    if (signal.direction === 'NO_TRADE' || signal.direction === 'flat' || !signal.direction) {
      console.error('❌ Invalid signal: valid=true but direction is NO_TRADE', signal);
      return false;
    }
    
    // Confidence must be 0-100
    const conf = typeof signal.confidence === 'number' ? signal.confidence : (signal.confidence * 100);
    if (conf < 0 || conf > 100 || isNaN(conf)) {
      console.error('❌ Invalid signal: confidence out of range', signal);
      return false;
    }
    
    // Stop loss must be logically correct for direction
    if (signal.direction === 'long' && signal.stopLoss >= signal.entryZone.min) {
      console.error('❌ Invalid signal: long trade stopLoss >= entryZone.min', signal);
      return false;
    }
    if (signal.direction === 'short' && signal.stopLoss <= signal.entryZone.max) {
      console.error('❌ Invalid signal: short trade stopLoss <= entryZone.max', signal);
      return false;
    }
  }
  
  return true;
}

/**
 * Normalize signal to canonical JSON structure
 * REFACTORED: Now enforces invariants - if signal is invalid, returns NO_TRADE
 * @param {Object} rawSignal - Raw signal from strategy evaluation
 * @param {Object} multiTimeframeData - Full timeframe data
 * @param {string} mode - STANDARD or AGGRESSIVE
 * @returns {Object} Canonical signal structure
 */
function normalizeToCanonical(rawSignal, multiTimeframeData, mode = 'STANDARD') {
  // Extract htfBias (should already be computed)
  // Safe htfBias access with fallback
  const htfBiasRaw = rawSignal.htfBias || computeHTFBias(multiTimeframeData);
  const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
  
  // Build timeframes object from multiTimeframeData
  const timeframes = {};
  for (const [tf, data] of Object.entries(multiTimeframeData)) {
    if (data && data.indicators && !data.error) {
      timeframes[tf] = {
        trend: data.indicators.analysis?.trend || 'UNKNOWN',
        ema21: data.indicators.ema?.ema21 || null,
        ema200: data.indicators.ema?.ema200 || null,
        stoch: data.indicators.stochRSI || null,
        pullback: {
          state: data.indicators.analysis?.pullbackState || 'UNKNOWN',
          distanceFrom21EMA: data.indicators.analysis?.distanceFrom21EMA || null
        },
        structure: data.structure || null,
        indicators: data.indicators || null
      };
    }
  }
  
  // Normalize confidence to 0-100 scale
  let normalizedConfidence = 0;
  if (rawSignal.confidence !== null && rawSignal.confidence !== undefined) {
    normalizedConfidence = typeof rawSignal.confidence === 'number' 
      ? (rawSignal.confidence > 1 ? rawSignal.confidence : rawSignal.confidence * 100)
      : 0;
    normalizedConfidence = Math.min(100, Math.max(0, normalizedConfidence));
  }
  
  // Normalize signal object - ensure all required fields exist
  const signal = {
    valid: rawSignal.valid || false,
    direction: rawSignal.direction || 'NO_TRADE',
    setupType: rawSignal.setupType || 'auto',
    selectedStrategy: rawSignal.selectedStrategy || 'NO_TRADE',
    strategiesChecked: rawSignal.strategiesChecked || [],
    confidence: normalizedConfidence, // Always 0-100 scale
    reason: rawSignal.reason_summary || rawSignal.reason || 'No trade setup available',
    entryZone: rawSignal.entry_zone || rawSignal.entryZone || { min: null, max: null },
    stopLoss: rawSignal.stop_loss || rawSignal.stopLoss || null,
    invalidationLevel: rawSignal.invalidation_level || rawSignal.invalidationLevel || null,
    targets: Array.isArray(rawSignal.targets) ? rawSignal.targets : 
            (rawSignal.targets?.tp1 ? [rawSignal.targets.tp1, rawSignal.targets.tp2] : [null, null]),
    riskReward: rawSignal.risk_reward || rawSignal.riskReward || { tp1RR: null, tp2RR: null },
    // Preserve new fields from enhanced confidence system
    entryType: rawSignal.entryType || 'pullback', // 'pullback' or 'breakout'
    penaltiesApplied: rawSignal.penaltiesApplied || [],
    capsApplied: rawSignal.capsApplied || [],
    explanation: rawSignal.explanation || null,
    confluence: rawSignal.confluence || null,
    invalidation: rawSignal.invalidation || null,
    conditionsRequired: rawSignal.conditionsRequired || [],
    override: rawSignal.override || false, // Mark if relaxed conditions were used
    notes: rawSignal.notes || [] // Array of notes about relaxed conditions or missing data
  };
  
  // CRITICAL: If signal claims to be valid but fails validation, force it to invalid
  if (signal.valid === true && !validateStrategySignal(signal)) {
    console.warn('⚠️ Signal failed validation, forcing to invalid:', signal);
    signal.valid = false;
    signal.direction = 'NO_TRADE';
    signal.confidence = 0;
    signal.entryZone = { min: null, max: null };
    signal.stopLoss = null;
    signal.invalidationLevel = null;
    signal.targets = [null, null];
    signal.reason = 'Signal failed validation - missing required fields';
  }
  
  // If invalid, ensure all fields are null/empty
  if (signal.valid === false) {
    signal.direction = 'NO_TRADE';
    signal.confidence = 0;
    if (!signal.entryZone || signal.entryZone.min !== null) {
      signal.entryZone = { min: null, max: null };
    }
    if (signal.stopLoss !== null) signal.stopLoss = null;
    if (signal.invalidationLevel !== null) signal.invalidationLevel = null;
    if (signal.targets && signal.targets[0] !== null) {
      signal.targets = [null, null];
    }
  }
  
  // Build meta object
  const meta = {
    scanTime: rawSignal.timestamp || new Date().toISOString(),
    mode: mode,
    currentPrice: rawSignal.currentPrice || null,
    ema21: rawSignal.ema21 || null,
    ema200: rawSignal.ema200 || null
  };
  
  // Return canonical structure
  return {
    symbol: rawSignal.symbol,
    price: rawSignal.currentPrice || null,
    htfBias: htfBias,
    timeframes: timeframes,
    signal: signal,
    meta: meta
  };
}

/**
 * Trading Mode Thresholds
 * STANDARD: Conservative, high-probability setups
 * AGGRESSIVE: Looser requirements for more trade opportunities (smaller position sizes)
 */
const THRESHOLDS = {
  STANDARD: {
    emaPullbackMax: 1.0,        // % from EMA21 for entry
    emaPullbackMax1H: 1.5,      // % from 1H EMA21 for 1H scalps
    microScalpEmaBand: 0.25,    // ±0.25% for micro-scalps
    allowFlat4HForScalp: false, // 4H must be trending for scalps
    allowFlat1HForScalp: false, // 1H must be trending for scalps
    allowFlat4HForSwing: false, // 4H must be trending for swings
    minHtfBiasConfidence: 60,   // Minimum HTF bias confidence
    maxSwingEmaDist1D: 3.0,     // Max % from 1D EMA21 for swing
    min15mStochAlign: true      // Require 15m stoch strict alignment
  },
  AGGRESSIVE: {
    emaPullbackMax: 1.75,       // Looser pullback zone
    emaPullbackMax1H: 2.5,      // Much looser 1H pullback
    microScalpEmaBand: 0.75,    // ±0.75% band for micro-scalps
    allowFlat4HForScalp: true,  // Allow 4H FLAT for scalps
    allowFlat1HForScalp: true,  // Allow 1H FLAT for scalps
    allowFlat4HForSwing: true,  // Allow 4H FLAT for swings (if 1D strong)
    minHtfBiasConfidence: 40,   // Accept weaker bias
    maxSwingEmaDist1D: 5.0,     // Wider swing entry zone
    min15mStochAlign: false     // Allow looser stoch alignment
  }
};

/**
 * Compute Higher Timeframe Bias from 4H + 1H
 * Replaces hard 4H FLAT gate with weighted scoring system
 * @param {Object} timeframes - All timeframe data
 * @returns {Object} HTF bias { direction, confidence, source }
 */
export function computeHTFBias(timeframes) {
  const tf4h = timeframes['4h'];
  const tf1h = timeframes['1h'];

  if (!tf4h || !tf1h) {
    return { direction: 'neutral', confidence: 0, source: 'none' };
  }

  let longScore = 0;
  let shortScore = 0;

  // Normalize trends for consistent comparison
  const trend4h = normalizeTrend(tf4h.indicators?.analysis?.trend);
  const trend1h = normalizeTrend(tf1h.indicators?.analysis?.trend);

  // 4H trend (weighted higher)
  if (trend4h === 'uptrend') longScore += 2;
  if (trend4h === 'downtrend') shortScore += 2;

  // 1H trend
  if (trend1h === 'uptrend') longScore += 1;
  if (trend1h === 'downtrend') shortScore += 1;

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
    // Check actual trends for tie-breaker (already normalized above)
    if (trend1h === 'uptrend') {
      return { direction: 'long', confidence: 60, source: '1h' };
    } else if (trend1h === 'downtrend') {
      return { direction: 'short', confidence: 60, source: '1h' };
    } else if (trend4h === 'uptrend') {
      return { direction: 'long', confidence: 50, source: '4h' };
    } else if (trend4h === 'downtrend') {
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
      source: trend4h !== 'flat' ? '4h' : '1h' 
    };
  } else if (shortScore > longScore) {
    const conf = Math.min(100, Math.round((shortScore / (longScore + shortScore)) * 100));
    return { 
      direction: 'short', 
      confidence: conf, 
      source: trend4h !== 'flat' ? '4h' : '1h' 
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
 * Try Aggressive Strategies
 * Called when AGGRESSIVE mode is enabled and conservative strategies found no trade
 * Uses looser requirements: wider EMA bands, allows FLAT trends, lower HTF bias
 * @param {string} symbol - Trading symbol
 * @param {Object} analysis - Multi-timeframe analysis
 * @param {Object} htfBias - HTF bias object
 * @param {Object} thresholds - AGGRESSIVE thresholds
 * @returns {Object} Trade signal or invalid signal
 */
function tryAggressiveStrategies(symbol, analysis, htfBias, thresholds) {
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  const tf15m = analysis['15m'];
  const tf5m = analysis['5m'];
  
  if (!tf4h || !tf1h || !tf15m || !tf5m) {
    return { valid: false };
  }
  
  const currentPrice = parseFloat(tf4h.price);
  const trend1h = tf1h.indicators?.analysis?.trend;
  
  // Block counter-trend scalps when HTF bias is strong (>= 70%)
  const strongBiasThreshold = 70;
  const isCounterTrendLong = htfBias && htfBias.confidence >= strongBiasThreshold && htfBias.direction === 'short';
  const isCounterTrendShort = htfBias && htfBias.confidence >= strongBiasThreshold && htfBias.direction === 'long';
  
  // AGGRESSIVE 1H SCALP: Allow 1H FLAT, wider pullback (±2.5%), looser stoch
  if (trend1h === 'UPTREND' || (thresholds.allowFlat1HForScalp && trend1h === 'FLAT')) {
    // Block counter-trend LONG scalps vs strong HTF SHORT bias
    if (isCounterTrendLong) {
      return {
        valid: false,
        direction: 'NO_TRADE',
        confidence: 0,
        reason: `Counter-trend LONG scalp blocked by strong HTF SHORT bias (${htfBias.confidence}%)`,
        entryZone: { min: null, max: null },
        stopLoss: null,
        invalidationLevel: null,
        targets: [],
        riskReward: { tp1RR: null, tp2RR: null },
        validationErrors: []
      };
    }
    
    const dist1h = Math.abs(tf1h.indicators?.analysis?.distanceFrom21EMA || 999);
    const dist15m = Math.abs(tf15m.indicators?.analysis?.distanceFrom21EMA || 999);
    const pullback15m = tf15m.indicators?.analysis?.pullbackState;
    
    if (dist1h <= thresholds.emaPullbackMax1H && dist15m <= thresholds.emaPullbackMax &&
        (pullback15m === 'ENTRY_ZONE' || pullback15m === 'RETRACING')) {
      
      const k15m = tf15m.indicators?.stochRSI?.k || 0;
      if (k15m < 75) {  // Not overbought
        const ema21_1h = parseFloat(tf1h.indicators?.ema?.ema21) || currentPrice;
        const ema21_15m = parseFloat(tf15m.indicators?.ema?.ema21) || currentPrice;
        const entry = (ema21_1h + ema21_15m) / 2;
        // Get swing lows with fallbacks
        const swingLow15m = parseFloat(tf15m.indicators?.swingLow);
        const swingLow1h = parseFloat(tf1h.indicators?.swingLow);
        
        // For aggressive scalp, use ONLY 15m swing low for tight invalidation
        // Fallback to 1h only if 15m doesn't exist, then percentage
        const stopLoss = swingLow15m || swingLow1h || (entry * 0.97);
        const R = Math.abs(entry - stopLoss);
        
        // Targets - ensure they're valid numbers
        const tp1_raw = entry + R * 1.5;
        const tp2_raw = entry + R * 3.0;
        const tp1 = !isNaN(tp1_raw) && isFinite(tp1_raw) ? parseFloat(tp1_raw.toFixed(2)) : null;
        const tp2 = !isNaN(tp2_raw) && isFinite(tp2_raw) ? parseFloat(tp2_raw.toFixed(2)) : null;
        const stopLossFinal = !isNaN(stopLoss) && isFinite(stopLoss) ? parseFloat(stopLoss.toFixed(2)) : null;
        
        return {
          valid: true,
          symbol,
          direction: 'long',
          setupType: 'AGGRO_SCALP_1H',
          selectedStrategy: 'AGGRO_SCALP_1H',
          strategiesChecked: ['SWING', 'TREND_4H', 'SCALP_1H', 'MICRO_SCALP', 'AGGRO_SCALP_1H'],
          confidence: 55, // 0-100 scale
          reason_summary: `Aggressive 1H scalp LONG: 1H ${trend1h}, 15m ${dist15m.toFixed(2)}% from EMA21, stoch ${k15m.toFixed(0)}. Counter-trend fade with small size.`,
          entry_zone: { 
            min: parseFloat((entry * 0.997).toFixed(2)), 
            max: parseFloat((entry * 1.003).toFixed(2))
          },
          stop_loss: stopLossFinal,
          invalidation_level: stopLossFinal,
          targets: [tp1, tp2],
          risk_reward: { tp1RR: 1.5, tp2RR: 3.0 },
          risk_amount: 0.005,  // 0.5% (half size)
          invalidation: {
            level: stopLossFinal,
            description: 'Aggressive scalp - exit immediately if 15m swing low breaks. No second chances on counter-trend.'
          },
          confluence: {
            trendAlignment: `FLAT on 4H, ${trend1h} on 1H (aggressive mode allows FLAT)`,
            stochMomentum: `15m stoch ${k15m.toFixed(0)} (oversold bounce)`,
            pullbackState: `15m ${pullback15m}, ${dist15m.toFixed(2)}% from EMA21`,
            liquidityZones: `Price at EMA21 cluster (aggro entry)`,
            htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source}) - COUNTER to bias`
          },
          conditionsRequired: [
            '⚠ AGGRESSIVE MODE: Counter-trend scalp with reduced size',
            '✓ 1H trend UPTREND or FLAT (aggressive allows FLAT)',
            '✓ 15m within ±2.5% of EMA21 (wider than standard ±1.0%)',
            '✓ 15m stoch not overbought (k < 75)',
            '✓ Position size: 0.5% risk (half of standard 1%)',
            '⚠ Exit immediately if wrong - tight invalidation'
          ],
          timestamp: new Date().toISOString(),
          currentPrice: currentPrice,
          ema21: ema21_1h,
          ema200: tf1h.indicators?.analysis?.ema200 || null
        };
      }
    }
  }
  
  // Try SHORT
  if (trend1h === 'DOWNTREND' || (thresholds.allowFlat1HForScalp && trend1h === 'FLAT')) {
    // Block counter-trend SHORT scalps vs strong HTF LONG bias
    if (isCounterTrendShort) {
      return {
        valid: false,
        direction: 'NO_TRADE',
        confidence: 0,
        reason: `Counter-trend SHORT scalp blocked by strong HTF LONG bias (${htfBias.confidence}%)`,
        entryZone: { min: null, max: null },
        stopLoss: null,
        invalidationLevel: null,
        targets: [],
        riskReward: { tp1RR: null, tp2RR: null },
        validationErrors: []
      };
    }
    
    const dist1h = Math.abs(tf1h.indicators?.analysis?.distanceFrom21EMA || 999);
    const dist15m = Math.abs(tf15m.indicators?.analysis?.distanceFrom21EMA || 999);
    const pullback15m = tf15m.indicators?.analysis?.pullbackState;
    
    if (dist1h <= thresholds.emaPullbackMax1H && dist15m <= thresholds.emaPullbackMax &&
        (pullback15m === 'ENTRY_ZONE' || pullback15m === 'RETRACING')) {
      
      const k15m = tf15m.indicators?.stochRSI?.k || 100;
      if (k15m > 25) {  // Not oversold
        const ema21_1h = parseFloat(tf1h.indicators?.ema?.ema21) || currentPrice;
        const ema21_15m = parseFloat(tf15m.indicators?.ema?.ema21) || currentPrice;
        const entry = (ema21_1h + ema21_15m) / 2;
        // Get swing highs with fallbacks
        const swingHigh15m = parseFloat(tf15m.indicators?.swingHigh);
        const swingHigh1h = parseFloat(tf1h.indicators?.swingHigh);
        
        // For aggressive scalp, use ONLY 15m swing high for tight invalidation
        // Fallback to 1h only if 15m doesn't exist, then percentage
        const stopLoss = swingHigh15m || swingHigh1h || (entry * 1.03);
        const R = Math.abs(entry - stopLoss);
        
        // Targets - ensure they're valid numbers
        const tp1_raw = entry - R * 1.5;
        const tp2_raw = entry - R * 3.0;
        const tp1 = !isNaN(tp1_raw) && isFinite(tp1_raw) ? parseFloat(tp1_raw.toFixed(2)) : null;
        const tp2 = !isNaN(tp2_raw) && isFinite(tp2_raw) ? parseFloat(tp2_raw.toFixed(2)) : null;
        const stopLossFinal = !isNaN(stopLoss) && isFinite(stopLoss) ? parseFloat(stopLoss.toFixed(2)) : null;
        
        return {
          valid: true,
          symbol,
          direction: 'short',
          setupType: 'AGGRO_SCALP_1H',
          selectedStrategy: 'AGGRO_SCALP_1H',
          strategiesChecked: ['SWING', 'TREND_4H', 'SCALP_1H', 'MICRO_SCALP', 'AGGRO_SCALP_1H'],
          confidence: 55, // 0-100 scale
          reason_summary: `Aggressive 1H scalp SHORT: 1H ${trend1h}, 15m ${dist15m.toFixed(2)}% from EMA21, stoch ${k15m.toFixed(0)}. Counter-trend fade with small size.`,
          entry_zone: { 
            min: parseFloat((entry * 0.997).toFixed(2)), 
            max: parseFloat((entry * 1.003).toFixed(2))
          },
          stop_loss: stopLossFinal,
          invalidation_level: stopLossFinal,
          targets: [tp1, tp2],
          risk_reward: { tp1RR: 1.5, tp2RR: 3.0 },
          risk_amount: 0.005,
          invalidation: {
            level: stopLossFinal,
            description: 'Aggressive scalp - exit immediately if 15m swing high breaks. No second chances on counter-trend.'
          },
          confluence: {
            trendAlignment: `FLAT on 4H, ${trend1h} on 1H (aggressive mode allows FLAT)`,
            stochMomentum: `15m stoch ${k15m.toFixed(0)} (overbought rejection)`,
            pullbackState: `15m ${pullback15m}, ${dist15m.toFixed(2)}% from EMA21`,
            liquidityZones: `Price at EMA21 cluster (aggro entry)`,
            htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source}) - COUNTER to bias`
          },
          conditionsRequired: [
            '⚠ AGGRESSIVE MODE: Counter-trend scalp with reduced size',
            '✓ 1H trend DOWNTREND or FLAT (aggressive allows FLAT)',
            '✓ 15m within ±2.5% of EMA21 (wider than standard ±1.0%)',
            '✓ 15m stoch not oversold (k > 25)',
            '✓ Position size: 0.5% risk (half of standard 1%)',
            '⚠ Exit immediately if wrong - tight invalidation'
          ],
          timestamp: new Date().toISOString(),
          currentPrice: currentPrice,
          ema21: ema21_1h,
          ema200: tf1h.indicators?.analysis?.ema200 || null
        };
      }
    }
  }
  
  // No aggressive trade found
  return { valid: false };
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
 * Calculate aggressive entry zone - ALWAYS close to or ahead of price action
 * Used for AGGRESSIVE mode trades to ensure entries are executable
 * @param {number} currentPrice - Current market price
 * @param {string} direction - 'long' or 'short'
 * @param {number} buffer - Buffer percentage (default 0.0003 = 0.03% ahead of price)
 * @returns {Object} { min, max } entry zone
 */
function calculateAggressiveEntryZone(currentPrice, direction, buffer = 0.0003) {
  if (!currentPrice || isNaN(currentPrice)) return null;
  
  // For AGGRESSIVE mode: Entry is always at or slightly ahead of current price
  if (direction === 'long') {
    // Longs: Entry slightly above current price (0.01% to 0.05% above)
    return {
      min: currentPrice * (1 + buffer * 0.33),  // 0.01% above price
      max: currentPrice * (1 + buffer * 1.67)   // 0.05% above price
    };
  } else {
    // Shorts: Entry slightly below current price (0.01% to 0.05% below)
    return {
      min: currentPrice * (1 - buffer * 1.67),  // 0.05% below price
      max: currentPrice * (1 - buffer * 0.33)    // 0.01% below price
    };
  }
}

/**
 * Calculate breakout entry zone above/below swing levels
 * Updated to place entries closer to price action
 * @param {number} swingLevel - Swing high (longs) or swing low (shorts)
 * @param {string} direction - 'long' or 'short'
 * @param {number} currentPrice - Current market price (to ensure entry is close)
 * @param {number} buffer - Buffer percentage (default 0.0002 = 0.02% for closer entries)
 * @returns {Object} { min, max } entry zone
 */
function calculateBreakoutEntryZone(swingLevel, direction, currentPrice = null, buffer = 0.0002) {
  if (!swingLevel || isNaN(swingLevel)) return null;
  
  // Entry zone: swingHigh + 0.02% for longs / swingLow - 0.02% for shorts (much closer to price)
  // Use ±0.01% range around the 0.02% anchor
  let entryZone;
  if (direction === 'long') {
    entryZone = {
      min: swingLevel * (1 + buffer * 0.5),  // swingHigh + 0.01%
      max: swingLevel * (1 + buffer * 1.5)   // swingHigh + 0.03% (centered around +0.02%)
    };
  } else {
    entryZone = {
      min: swingLevel * (1 - buffer * 1.5),  // swingLow - 0.03% (centered around -0.02%)
      max: swingLevel * (1 - buffer * 0.5)    // swingLow - 0.01%
    };
  }
  
  // If current price is provided, ensure entry zone is close to price (within 0.5%)
  if (currentPrice && !isNaN(currentPrice)) {
    const entryMid = (entryZone.min + entryZone.max) / 2;
    const distanceFromPrice = Math.abs(entryMid - currentPrice) / currentPrice;
    
    // If entry is too far from price (>0.5%), adjust it closer
    if (distanceFromPrice > 0.005) {
      if (direction === 'long') {
        // For longs, entry should be at or slightly above current price if price is near swing
        if (currentPrice >= swingLevel * 0.999) { // Price is within 0.1% of swing high
          entryZone = {
            min: currentPrice * 1.0001,  // 0.01% above current price
            max: currentPrice * 1.0003   // 0.03% above current price
          };
        }
      } else {
        // For shorts, entry should be at or slightly below current price if price is near swing
        if (currentPrice <= swingLevel * 1.001) { // Price is within 0.1% of swing low
          entryZone = {
            min: currentPrice * 0.9997,  // 0.03% below current price
            max: currentPrice * 0.9999    // 0.01% below current price
          };
        }
      }
    }
  }
  
  return entryZone;
}

/**
 * Check if price is near swing level and momentum supports breakout entry
 * Updated to be more aggressive - triggers when price is near swing levels, not just after breaking
 * @param {number} currentPrice - Current price
 * @param {number} swingLevel - Swing high (longs) or swing low (shorts)
 * @param {string} direction - 'long' or 'short'
 * @param {Object} stochRSI - StochRSI indicator object
 * @param {number} nearThreshold - How close price must be to swing level (default 0.5% = 0.005)
 * @returns {boolean} True if breakout entry should be used
 */
function isBreakoutConfirmed(currentPrice, swingLevel, direction, stochRSI, nearThreshold = 0.005) {
  if (!swingLevel || !stochRSI || isNaN(swingLevel) || isNaN(currentPrice)) return false;
  
  // Check if price is near swing level (within 0.5% for longs, or at/above for shorts)
  const priceNearSwing = direction === 'long'
    ? currentPrice >= swingLevel * (1 - nearThreshold)  // Price within 0.5% below swing high OR above
    : currentPrice <= swingLevel * (1 + nearThreshold);  // Price within 0.5% above swing low OR below
  
  // Momentum confirmation: More lenient - just need momentum aligned, not strict K thresholds
  const momentumOk = direction === 'long'
    ? (stochRSI.condition === 'BULLISH' || stochRSI.condition === 'OVERSOLD' || (stochRSI.k && stochRSI.k < 50))  // K<50 for longs (more lenient)
    : (stochRSI.condition === 'BEARISH' || stochRSI.condition === 'OVERBOUGHT' || (stochRSI.k && stochRSI.k > 50)); // K>50 for shorts (more lenient)
  
  return priceNearSwing && momentumOk;
}

/**
 * Helper function to return a standardized NO_TRADE signal
 * @param {string} reason - Reason for no trade
 * @returns {Object} Standardized NO_TRADE signal structure
 */
function invalidNoTrade(reason) {
  return {
    valid: false,
    direction: 'NO_TRADE',
    confidence: 0,
    reason,
    entryZone: { min: null, max: null },
    stopLoss: null,
    invalidationLevel: null,
    targets: [],
    riskReward: { tp1RR: null, tp2RR: null },
    validationErrors: []
  };
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

// Legacy calculateConfidence() function removed - now using calculateConfidenceWithHierarchy() exclusively

/**
 * Check dFlow alignment with trade direction
 * @param {Object} dflowData - dFlow prediction market data
 * @param {string} direction - 'long' or 'short'
 * @returns {Object} { aligned: boolean, bonus: number, explanation: string }
 */
function checkDflowAlignment(dflowData, direction) {
  if (!dflowData || dflowData.error || !dflowData.events || dflowData.events.length === 0) {
    return { aligned: null, bonus: 0, explanation: 'No dFlow data available' };
  }
  
  // Check all markets across all events for alignment
  let alignedCount = 0;
  let totalMarkets = 0;
  
  for (const event of dflowData.events) {
    if (event.markets && Array.isArray(event.markets)) {
      for (const market of event.markets) {
        if (market.yesProbability !== null && market.noProbability !== null) {
          totalMarkets++;
          const isAligned = direction === 'long'
            ? market.yesProbability > 60  // Long: YES > 60%
            : market.noProbability > 60;   // Short: NO > 60%
          
          if (isAligned) alignedCount++;
        }
      }
    }
  }
  
  if (totalMarkets === 0) {
    return { aligned: null, bonus: 0, explanation: 'No valid dFlow markets' };
  }
  
  const alignmentRatio = alignedCount / totalMarkets;
  const aligned = alignmentRatio >= 0.5;  // 50%+ markets aligned
  
  return {
    aligned,
    bonus: aligned ? 5 : -5,  // +5% if aligned, -5% if contradicts
    explanation: `${alignedCount}/${totalMarkets} markets align with ${direction} direction`
  };
}

/**
 * Calculate confidence with hierarchical weighting
 * Uses macro (1M, 1W, 3D, 1D), primary (4H, 1H), and execution (15m, 5m, 3m, 1m) layers
 * @param {Object} multiTimeframeData - All timeframe analysis data
 * @param {string} direction - 'long' or 'short'
 * @param {string} mode - 'STANDARD' or 'AGGRESSIVE'
 * @param {string} strategyName - Strategy name for base confidence (SWING, TREND_4H, TREND_RIDER, SCALP_1H, MICRO_SCALP)
 * @param {Object} marketData - Market data for volume quality and trade flow filters
 * @param {Object} dflowData - dFlow prediction market data for alignment check
 * @returns {Object} { confidence: 0-100, penaltiesApplied: [], capsApplied: [], explanation: string }
 */
function calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode = 'STANDARD', strategyName = null, marketData = null, dflowData = null) {
  const penaltiesApplied = [];
  const capsApplied = [];
  
  // Strategy-specific base confidence
  const BASE_CONFIDENCE = {
    'SWING': 80,
    'TREND_4H': 75,
    'TREND_RIDER': 75,
    'SCALP_1H': 70,
    'MICRO_SCALP': 65
  };
  
  let baseConfidence = strategyName && BASE_CONFIDENCE[strategyName] ? BASE_CONFIDENCE[strategyName] : 0;
  
  // Configuration - make caps configurable
  const CAPS = {
    STANDARD: {
      MACRO_CONTRADICTION: 75,
      PRIMARY_CONTRADICTION: 65,
      MACRO_PRIMARY_CONTRADICTION: 55,
      EXHAUSTION_CONTRADICTION: 45
    },
    AGGRESSIVE: {
      MACRO_CONTRADICTION: 80,
      PRIMARY_CONTRADICTION: 70,
      MACRO_PRIMARY_CONTRADICTION: 60,
      EXHAUSTION_CONTRADICTION: 50
    }
  };
  
  const caps = CAPS[mode] || CAPS.STANDARD;
  
  // 1. MACRO TREND LAYER (40% weight)
  const macroTfs = ['1M', '1w', '3d', '1d'];
  const macroTrends = {};
  let macroAlignment = 0;
  let macroContradiction = false;
  let macroContradictionLevel = 'none';
  let availableMacroTfs = 0;
  
  for (const tf of macroTfs) {
    const data = multiTimeframeData[tf];
    if (data && data.indicators && data.indicators.analysis) {
      const trend = normalizeTrend(data.indicators.analysis.trend);
      macroTrends[tf] = trend;
      availableMacroTfs++;
      
      if (trend === 'uptrend' && direction === 'long') {
        macroAlignment += 0.1;
      } else if (trend === 'downtrend' && direction === 'short') {
        macroAlignment += 0.1;
      } else if (trend !== 'flat' && (
        (trend === 'uptrend' && direction === 'short') ||
        (trend === 'downtrend' && direction === 'long')
      )) {
        macroContradiction = true;
        if (tf === '1d') {
          macroContradictionLevel = 'severe';
        } else if (macroContradictionLevel === 'none') {
          macroContradictionLevel = 'moderate';
        }
      }
    }
  }
  
  // Normalize macro alignment if not all TFs available
  if (availableMacroTfs > 0) {
    macroAlignment = macroAlignment / availableMacroTfs * macroTfs.length;
  }
  
  // Apply hierarchical weighting as multipliers to base confidence
  const macroWeight = 0.4;
  let macroMultiplier = 1.0;
  
  // Apply macro penalties
  if (macroContradiction) {
    macroMultiplier = macroContradictionLevel === 'severe' ? 0.4 : 
                      macroContradictionLevel === 'moderate' ? 0.6 : 0.75;
    penaltiesApplied.push({
      layer: 'macro',
      level: macroContradictionLevel,
      multiplier: macroMultiplier,
      reason: `${macroContradictionLevel} macro contradiction detected`
    });
  } else if (macroAlignment > 0) {
    // Bonus for macro alignment
    macroMultiplier = 1.0 + (macroAlignment * 0.1); // Up to 10% bonus
  }
  
  // 2. PRIMARY TREND LAYER (35% weight)
  const tf4h = multiTimeframeData['4h'];
  const tf1h = multiTimeframeData['1h'];
  let primaryAlignment = 0;
  let primaryContradiction = false;
  let primaryMultiplier = 1.0;
  
  if (tf4h && tf1h && tf4h.indicators && tf1h.indicators) {
    const trend4h = normalizeTrend(tf4h.indicators.analysis?.trend);
    const trend1h = normalizeTrend(tf1h.indicators.analysis?.trend);
    
    if (trend4h === 'flat' && trend1h !== 'flat') {
      // 4H flat but 1H aligned
      if ((trend1h === 'uptrend' && direction === 'long') ||
          (trend1h === 'downtrend' && direction === 'short')) {
        primaryAlignment = 0.85;
        primaryMultiplier = 0.85;
        penaltiesApplied.push({
          layer: 'primary',
          reason: '4H flat but 1H aligned',
          multiplier: 0.85
        });
      }
    } else if ((trend4h === 'uptrend' && direction === 'long') ||
               (trend4h === 'downtrend' && direction === 'short')) {
      primaryAlignment = 1.0;
      primaryMultiplier = 1.0;
    } else if (trend4h !== 'flat') {
      primaryContradiction = true;
      primaryAlignment = 0.5;
      primaryMultiplier = 0.5;
      penaltiesApplied.push({
        layer: 'primary',
        reason: '4H contradicts direction',
        multiplier: 0.5
      });
    }
    
    if (trend1h === 'uptrend' && direction === 'long') {
      primaryAlignment = Math.min(1.0, primaryAlignment + 0.15);
      if (primaryMultiplier < 1.0) primaryMultiplier = Math.min(1.0, primaryMultiplier + 0.15);
    } else if (trend1h === 'downtrend' && direction === 'short') {
      primaryAlignment = Math.min(1.0, primaryAlignment + 0.15);
      if (primaryMultiplier < 1.0) primaryMultiplier = Math.min(1.0, primaryMultiplier + 0.15);
    }
  }
  
  // 3. EXECUTION LAYER (25% weight)
  const execTfs = ['15m', '5m', '3m', '1m'];
  let execAlignment = 0;
  let exhaustionCount = 0;
  let availableExecTfs = 0;
  let execMultiplier = 1.0;
  
  for (const tf of execTfs) {
    const data = multiTimeframeData[tf];
    if (data && data.indicators && data.indicators.stochRSI) {
      availableExecTfs++;
      const stoch = data.indicators.stochRSI;
      const isOverbought = stoch.k > 80 && stoch.d > 80;
      const isOversold = stoch.k < 20 && stoch.d < 20;
      
      if (direction === 'long' && isOverbought) {
        exhaustionCount++;
        execAlignment += 0.9;
      } else if (direction === 'short' && isOversold) {
        exhaustionCount++;
        execAlignment += 0.9;
      } else {
        execAlignment += 1.0;
      }
    }
  }
  
  const avgExecAlignment = availableExecTfs > 0 ? execAlignment / availableExecTfs : 1.0;
  
  if (exhaustionCount >= 2) {
    execMultiplier = 0.7;
    penaltiesApplied.push({
      layer: 'execution',
      reason: `${exhaustionCount} lower timeframes show exhaustion`,
      multiplier: 0.7
    });
  }
  
  // Apply hierarchical multipliers to base confidence
  baseConfidence = baseConfidence * (
    (macroMultiplier * 0.4) + 
    (primaryMultiplier * 0.35) + 
    (avgExecAlignment * 0.25)
  );
  
  // Apply volume quality filter
  // Apply volume quality filter with fallback for missing data
  let volumeNote = null;
  if (marketData && marketData.volumeQuality) {
    if (marketData.volumeQuality === 'LOW') {
      baseConfidence -= 5;
      penaltiesApplied.push({
        layer: 'market',
        reason: 'Low volume quality',
        multiplier: 0.95
      });
    }
  } else {
    // Missing volume data - treat as neutral (no penalty)
    volumeNote = 'Volume quality missing - no penalty applied';
  }
  
  // Apply trade flow filter
  if (marketData && marketData.recentTrades) {
    const { buyPressure, sellPressure, overallFlow } = marketData.recentTrades;
    
    if (direction === 'long' && buyPressure < sellPressure) {
      baseConfidence -= 3;
      penaltiesApplied.push({
        layer: 'market',
        reason: 'Sell pressure exceeds buy pressure',
        multiplier: 0.97
      });
    } else if (direction === 'short' && sellPressure < buyPressure) {
      baseConfidence -= 3;
      penaltiesApplied.push({
        layer: 'market',
        reason: 'Buy pressure exceeds sell pressure',
        multiplier: 0.97
      });
    }
    
    // Bonus for strong flow alignment
    if (direction === 'long' && overallFlow === 'BUY' && buyPressure > 60) {
      baseConfidence += 3;
    } else if (direction === 'short' && overallFlow === 'SELL' && sellPressure > 60) {
      baseConfidence += 3;
    }
  }
  
  // Apply dFlow alignment filter with fallback for missing data
  let dflowScore = 0;
  let dflowNote = null;
  if (dflowData && dflowData.events && Array.isArray(dflowData.events) && dflowData.events.length > 0) {
    const dflowCheck = checkDflowAlignment(dflowData, direction);
    if (dflowCheck.bonus !== 0) {
      baseConfidence += dflowCheck.bonus;
      dflowScore = dflowCheck.bonus;
      if (dflowCheck.bonus > 0) {
        penaltiesApplied.push({
          layer: 'dflow',
          reason: `dFlow alignment: ${dflowCheck.explanation}`,
          multiplier: 1.0 + (dflowCheck.bonus / 100)
        });
      } else {
        penaltiesApplied.push({
          layer: 'dflow',
          reason: `dFlow contradiction: ${dflowCheck.explanation}`,
          multiplier: 1.0 + (dflowCheck.bonus / 100)
        });
      }
    }
  } else {
    // Missing dFlow data - treat as neutral (no bonus/penalty)
    dflowScore = 0;
    dflowNote = 'dFlow data missing - treated as neutral';
  }
  
  // Check if all conditions align for 95% cap in AGGRESSIVE mode
  const allConditionsAligned = mode === 'AGGRESSIVE' &&
    !macroContradiction &&
    !primaryContradiction &&
    exhaustionCount < 2 &&
    (!marketData || marketData.volumeQuality !== 'LOW') &&
    (dflowData ? checkDflowAlignment(dflowData, direction).aligned === true : true);
  
  // Apply hard caps
  let finalConfidence = Math.min(100, Math.max(0, baseConfidence));
  
  // Special case: 95% cap in AGGRESSIVE when all conditions align
  if (allConditionsAligned && finalConfidence > 95) {
    capsApplied.push('MAX_AGGRESSIVE_ALIGNED');
    finalConfidence = Math.min(finalConfidence, 95);
  } else {
    // Apply standard caps
    if (macroContradiction && primaryContradiction) {
      if (finalConfidence > caps.MACRO_PRIMARY_CONTRADICTION) {
        capsApplied.push('MACRO_PRIMARY_CONTRADICTION');
        finalConfidence = Math.min(finalConfidence, caps.MACRO_PRIMARY_CONTRADICTION);
      }
    } else if (macroContradiction) {
      if (finalConfidence > caps.MACRO_CONTRADICTION) {
        capsApplied.push('MACRO_CONTRADICTION');
        finalConfidence = Math.min(finalConfidence, caps.MACRO_CONTRADICTION);
      }
    } else if (primaryContradiction) {
      if (finalConfidence > caps.PRIMARY_CONTRADICTION) {
        capsApplied.push('PRIMARY_CONTRADICTION');
        finalConfidence = Math.min(finalConfidence, caps.PRIMARY_CONTRADICTION);
      }
    }
    
    if (exhaustionCount >= 2 && (macroContradiction || primaryContradiction)) {
      if (finalConfidence > caps.EXHAUSTION_CONTRADICTION) {
        capsApplied.push('EXHAUSTION_CONTRADICTION');
        finalConfidence = Math.min(finalConfidence, caps.EXHAUSTION_CONTRADICTION);
      }
    }
  }
  
  // Build explanation
  const explanation = buildConfidenceExplanation(
    macroTrends, macroContradiction, primaryContradiction, 
    exhaustionCount, penaltiesApplied, capsApplied, finalConfidence, baseConfidence
  );
  
  return {
    confidence: Math.round(finalConfidence),
    penaltiesApplied,
    capsApplied,
    explanation,
    dflowNote: dflowNote || null, // Return note for missing dFlow data
    volumeNote: volumeNote || null // Return note for missing volume data
  };
}

/**
 * Build confidence explanation string
 */
function buildConfidenceExplanation(macroTrends, macroContradiction, primaryContradiction, 
                                   exhaustionCount, penaltiesApplied, capsApplied, 
                                   finalConfidence, baseConfidence) {
  let explanation = '';
  
  // Macro alignment
  const macroTfList = Object.keys(macroTrends).filter(tf => macroTrends[tf] !== 'flat').join('/');
  explanation += `Macro alignment (${macroTfList || 'none'}): `;
  explanation += macroContradiction ? 'contradiction detected. ' : 'aligned. ';
  
  // Primary alignment
  explanation += `Primary trend (4H+1H): `;
  explanation += primaryContradiction ? 'contradiction. ' : 'aligned. ';
  
  // Penalties
  if (penaltiesApplied.length > 0) {
    explanation += `Penalties: ${penaltiesApplied.map(p => p.reason).join(', ')}. `;
  }
  
  // Caps
  if (capsApplied.length > 0) {
    explanation += `Caps applied: ${capsApplied.join(', ')}. `;
  }
  
  // Final confidence
  if (baseConfidence !== finalConfidence) {
    explanation += `Confidence reduced from ${Math.round(baseConfidence)}% → ${finalConfidence}%`;
  } else {
    explanation += `Final confidence: ${finalConfidence}%`;
  }
  
  return explanation;
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
  
  const trend4h = tf4h.indicators?.analysis?.trend ? tf4h.indicators.analysis.trend.toLowerCase() : 'unknown';
  const trend1h = tf1h?.indicators?.analysis?.trend ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown';
  const pullback = tf4h.indicators?.analysis?.pullbackState ? tf4h.indicators.analysis.pullbackState.toLowerCase().replace('_', ' ') : 'unknown';
  
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
function evaluateSwingSetup(multiTimeframeData, currentPrice, mode = 'STANDARD', marketData = null, dflowData = null, overrideUsed = false) {
  const tf3d = multiTimeframeData['3d'];
  const tf1d = multiTimeframeData['1d'];
  const tf4h = multiTimeframeData['4h'];
  
  // Guard: Need all required timeframes
  if (!tf3d || !tf1d || !tf4h) {
    return null;
  }
  
  // Extract indicators - FIX: Use correct data paths (indicators.analysis.trend, not indicators.trend)
  const trend3d = tf3d.indicators?.analysis?.trend;
  const trend1d = tf1d.indicators?.analysis?.trend;
  const trend4h = tf4h.indicators?.analysis?.trend;
  const pullback3d = {
    state: tf3d.indicators?.analysis?.pullbackState,
    distanceFrom21EMA: tf3d.indicators?.analysis?.distanceFrom21EMA
  };
  const pullback1d = {
    state: tf1d.indicators?.analysis?.pullbackState,
    distanceFrom21EMA: tf1d.indicators?.analysis?.distanceFrom21EMA
  };
  const pullback4h = {
    state: tf4h.indicators?.analysis?.pullbackState,
    distanceFrom21EMA: tf4h.indicators?.analysis?.distanceFrom21EMA
  };
  const stoch3d = tf3d.indicators?.stochRSI || {};
  const stoch1d = tf1d.indicators?.stochRSI || {};
  const stoch4h = tf4h.indicators?.stochRSI || {};
  const ema21_4h = tf4h.indicators?.ema?.ema21;
  const ema21_1d = tf1d.indicators?.ema?.ema21;
  const swingLow3d = tf3d.structure?.swingLow;
  const swingLow1d = tf1d.structure?.swingLow;
  const swingHigh3d = tf3d.structure?.swingHigh;
  const swingHigh1d = tf1d.structure?.swingHigh;
  
  // Guard: Need all data points
  if (!trend3d || !trend1d || !trend4h || !pullback3d.state || !pullback1d.state || !pullback4h.state ||
      !stoch3d || !stoch1d || !stoch4h || !ema21_4h || !ema21_1d || !currentPrice) {
    return null;
  }
  
  // 1) GATEKEEPERS — WHEN SWING IS EVEN ALLOWED
  // Normalize trends for comparison
  const trend3dNorm = normalizeTrend(trend3d);
  const trend1dNorm = normalizeTrend(trend1d);
  const trend4hNorm = normalizeTrend(trend4h);
  
  // 4H trend must NOT be FLAT for swing trades, UNLESS override is used
  if (trend4hNorm === 'flat' && !overrideUsed) {
    return null;
  }
  
  // 3D trend must NOT be FLAT
  if (trend3dNorm === 'flat') {
    return null;
  }
  
  // 1D trend must be either UPTREND or DOWNTREND
  if (trend1dNorm === 'flat') {
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
    htf3d: trend3dNorm === 'uptrend' || 
           (trend3dNorm === 'flat' && (stoch3d.condition === 'BULLISH' || stoch3d.condition === 'OVERSOLD')),
    
    // 1D trending down BUT with bullish pivot signs
    htf1d: trend1dNorm === 'downtrend' && 
           (stoch1d.condition === 'BULLISH' || stoch1d.k < 25),
    
    // HTF Pullback: 3D overextended below 21EMA
    pullback3d: pullback3d.state === 'OVEREXTENDED' && 
                (pullback3d.distanceFrom21EMA < -8 || pullback3d.distanceFrom21EMA > -15),
    
    // 1D pullback
    pullback1d: pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE',
    
    // Price near 1D EMA21 but not nuking below 1D swing low
    pricePosition: currentPrice >= (swingLow1d || ema21_1d * 0.90) && 
                   currentPrice <= ema21_1d * 1.02,
    
    // 4H Confirmation (EMA distance check removed - will use confidence penalty instead)
    conf4h: (trend4hNorm === 'uptrend' || (trend4hNorm === 'flat' && stoch4h.condition === 'BULLISH')) &&
            (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE')
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
      htf3d: trend3dNorm === 'downtrend' || 
             (trend3dNorm === 'flat' && (stoch3d.condition === 'BEARISH' || stoch3d.condition === 'OVERBOUGHT')),
      
      // 1D trending up BUT with bearish rejection signs
      htf1d: trend1dNorm === 'uptrend' && 
             (stoch1d.condition === 'BEARISH' || stoch1d.k > 75),
      
      // HTF Pullback: 3D overextended above 21EMA
      pullback3d: pullback3d.state === 'OVEREXTENDED' && 
                  (pullback3d.distanceFrom21EMA > 8 || pullback3d.distanceFrom21EMA < 15),
      
      // 1D pullback
      pullback1d: pullback1d.state === 'RETRACING' || pullback1d.state === 'ENTRY_ZONE',
      
      // Price near 1D EMA21 but not blowing past 1D swing high
      pricePosition: currentPrice <= (swingHigh1d || ema21_1d * 1.10) && 
                     currentPrice >= ema21_1d * 0.98,
      
      // 4H Confirmation (EMA distance check removed - will use confidence penalty instead)
      conf4h: (trend4hNorm === 'downtrend' || (trend4hNorm === 'flat' && stoch4h.condition === 'BEARISH')) &&
              (pullback4h.state === 'RETRACING' || pullback4h.state === 'ENTRY_ZONE')
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
  
  // Entry zone: AGGRESSIVE mode ALWAYS uses aggressive entries
  let entryMin, entryMax, entryType = 'pullback';
  
  // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
  if (mode === 'AGGRESSIVE') {
    const aggressiveZone = calculateAggressiveEntryZone(currentPrice, direction);
    if (aggressiveZone) {
      entryMin = aggressiveZone.min;
      entryMax = aggressiveZone.max;
      entryType = 'breakout'; // Mark as breakout since it's ahead of price
    } else {
      // Fallback: use current price ±0.05%
      if (direction === 'long') {
        entryMin = currentPrice * 1.0001;
        entryMax = currentPrice * 1.0005;
      } else {
        entryMin = currentPrice * 0.9995;
        entryMax = currentPrice * 0.9999;
      }
      entryType = 'breakout';
    }
  } else {
    // STANDARD mode: Prioritize breakout entry when conditions are met
    const swingLevel = direction === 'long' ? swingHigh1d : swingLow1d;
    const stoch1dForBreakout = stoch1d;
    
    // Prioritize breakout entry - check if price is near swing level with momentum
    if (swingLevel && stoch1dForBreakout && isBreakoutConfirmed(currentPrice, swingLevel, direction, stoch1dForBreakout)) {
      // Use breakout entry zone (closer to price action)
      const breakoutZone = calculateBreakoutEntryZone(swingLevel, direction, currentPrice);
      if (breakoutZone) {
        entryMin = breakoutZone.min;
        entryMax = breakoutZone.max;
        entryType = 'breakout';
      } else {
        // Fallback to pullback entry
        entryMin = reclaimLevel * 0.995;
        entryMax = reclaimLevel * 1.005;
      }
    } else {
      // Use pullback entry zone only if breakout conditions not met
      entryMin = reclaimLevel * 0.995;
      entryMax = reclaimLevel * 1.005;
    }
  }
  
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
  
  // Use hierarchical confidence system for Swing with strategy name and filters
  const confidenceResult = calculateConfidenceWithHierarchy(
    multiTimeframeData, 
    direction, 
    mode,
    'SWING',      // Strategy name for base confidence
    marketData,   // Volume quality filter
    dflowData     // dFlow alignment
  );
  let confidence = confidenceResult.confidence;
  const penaltiesApplied = confidenceResult.penaltiesApplied;
  const capsApplied = confidenceResult.capsApplied;
  const confidenceExplanation = confidenceResult.explanation;
  
  // Apply volume quality soft block for MICRO_SCALP (not applicable to SWING, but keep pattern)
  // Volume quality penalty already applied in calculateConfidenceWithHierarchy
  
  // Swing-specific bonuses (applied after hierarchical calculation)
  // Boost for strong stoch alignment
  if (direction === 'long' && stoch3d.condition === 'OVERSOLD' && stoch1d.condition === 'BULLISH') {
    confidence = Math.min(90, confidence + 5);
  } else if (direction === 'short' && stoch3d.condition === 'OVERBOUGHT' && stoch1d.condition === 'BEARISH') {
    confidence = Math.min(90, confidence + 5);
  }
  // Boost for tight 4H entry
  if (Math.abs(currentPrice - ema21_4h) / currentPrice <= 0.005) { // within ±0.5%
    confidence = Math.min(90, confidence + 3);
  }
  // Boost for strong 3D overextension
  const dist3d = Math.abs(pullback3d.distanceFrom21EMA);
  if (dist3d >= 10) {
    confidence = Math.min(90, confidence + 2);
  }
  
  confidence = Math.min(confidence, 90);
  
  // Global minimum confidence threshold (SWING uses STANDARD mode)
  const minConfidenceSafe = 60;
  if (confidence < minConfidenceSafe) {
    return {
      valid: false,
      direction: 'NO_TRADE',
      confidence: Math.round(confidence),
      reason: `Setup rejected: confidence ${confidence.toFixed(1)}% below minimum ${minConfidenceSafe}%`,
      entryZone: { min: null, max: null },
      stopLoss: null,
      invalidationLevel: null,
      targets: [],
      riskReward: { tp1RR: null, tp2RR: null },
      validationErrors: []
    };
  }
  
  // Compute HTF Bias for Swing - use fallback to prevent null reference
  const htfBiasRaw = computeHTFBias(multiTimeframeData);
  const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
  
  // Build swing signal
  return {
    valid: true,
    direction: direction,
    setupType: 'Swing',
    selectedStrategy: 'SWING',
    strategiesChecked: ['SWING'],
    confidence: Math.round(confidence), // Keep as 0-100 scale
    reason: reason,
    reason_summary: confidenceExplanation ? `${reason} [${confidenceExplanation}]` : reason,
    penaltiesApplied: penaltiesApplied,
    capsApplied: capsApplied,
    explanation: confidenceExplanation,
    entryType: entryType, // 'pullback' or 'breakout'
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
export function evaluateStrategy(symbol, multiTimeframeData, setupType = '4h', mode = 'STANDARD', marketData = null, dflowData = null, overrideUsed = false) {
  const analysis = multiTimeframeData;
  const tf3d = analysis['3d'];
  const tf1d = analysis['1d'];
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  const tf15m = analysis['15m'];
  const tf5m = analysis['5m'];
  const tf1m = analysis['1m'];
  
  // Get thresholds for current mode
  const thresholds = mode === 'AGGRESSIVE' ? THRESHOLDS.AGGRESSIVE : THRESHOLDS.STANDARD;
  
  // Must have at least 4h data
  if (!tf4h || !tf4h.indicators) {
    const rawSignal = {
      symbol,
      direction: 'flat',
      reason: 'Insufficient 4h data',
      confidence: 0,
      valid: false,
      setupType: 'auto',
      selectedStrategy: 'NO_TRADE',
      strategiesChecked: []
    };
    return normalizeToCanonical(rawSignal, analysis, mode);
  }
  
  // Normalize trend for consistent comparison
  const trend4hRaw = tf4h.indicators.analysis.trend;
  const trend4h = normalizeTrend(trend4hRaw);
  const currentPrice = tf4h.indicators.price.current;
  const ema21 = tf4h.indicators.ema.ema21;
  const ema200 = tf4h.indicators.ema.ema200;
  const pullbackState = tf4h.indicators.analysis.pullbackState;
  
  // PRIORITY 1: Check for 3D Swing Setup (if setupType is 'Swing' OR auto-detect)
  if (setupType === 'Swing' || setupType === 'auto') {
    const swingSignal = evaluateSwingSetup(analysis, currentPrice, mode, marketData, dflowData, overrideUsed);
    if (swingSignal && swingSignal.valid) {
      // Return swing signal directly (already includes htfBias)
      const rawSignal = {
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
      return normalizeToCanonical(rawSignal, analysis, mode);
    }
    // If swing was requested but not valid, and setupType is explicitly 'Swing', return no trade with specific reason
    if (setupType === 'Swing') {
      // Check specific failure reasons
      const tf3d = analysis['3d'];
      const tf1d = analysis['1d'];
      const tf4h = analysis['4h'];
      
      let swingReason = '3D/1D/4H swing conditions not met';
      if (!tf3d || !tf1d || !tf4h) {
        const missing = [];
        if (!tf3d) missing.push('3D');
        if (!tf1d) missing.push('1D');
        if (!tf4h) missing.push('4H');
        swingReason = `3D/1D/4H structure not loaded - missing ${missing.join(', ')} timeframe data`;
      } else {
        const trend3d = tf3d.indicators?.trend;
        const trend1d = tf1d.indicators?.trend;
        const trend4h = tf4h.indicators?.trend;
        
        if (trend4h === 'FLAT') {
          swingReason = '4H trend is FLAT - swing trades require clear 4H direction';
        } else if (trend3d === 'FLAT') {
          swingReason = '3D trend is FLAT - swing trades require clear 3D direction';
        } else if (trend1d === 'FLAT') {
          swingReason = '1D trend is FLAT - swing trades require clear 1D direction';
        } else {
          swingReason = '3D/1D/4H structure not aligned - swing setup conditions not met';
        }
      }
      
      const rawSignal = {
        symbol,
        direction: 'flat',
        reason: swingReason,
        confidence: 0,
        valid: false,
        setupType: 'Swing',
        selectedStrategy: 'NO_TRADE',
        strategiesChecked: ['SWING']
      };
      return normalizeToCanonical(rawSignal, analysis, mode);
    }
  }
  
  // NEW: Compute HTF Bias instead of hard 4H gate
  // Compute HTF bias with fallback to prevent null reference - MUST be computed before use
  let htfBiasRaw = null;
  try {
    htfBiasRaw = computeHTFBias(analysis);
  } catch (biasError) {
    console.error(`[evaluateStrategy] ${symbol} ERROR computing HTF bias:`, biasError.message);
  }
  const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
  
  // PRIORITY 2: Try 4H Trend Play
  // SAFE_MODE: Only if 4H is NOT FLAT, UNLESS override is used
  // AGGRESSIVE_MODE: Can use HTF bias + lower TFs even when 4H is FLAT (always allow in AGGRESSIVE)
  const canTry4HTrend = (mode === 'STANDARD' && (trend4h !== 'flat' || overrideUsed)) || 
                        (mode === 'AGGRESSIVE'); // AGGRESSIVE always allows 4H trend evaluation, STANDARD allows if override used
  
  if (canTry4HTrend && (setupType === '4h' || setupType === 'auto')) {
    // Continue with existing 4H trend logic below
    let direction = null;
    let setupValid = false;
    const invalidationReasons = [];
    
    // AGGRESSIVE_MODE or STANDARD with override: When 4H is flat, use HTF bias + lower TFs for direction
    // htfBias is now safely initialized above - use local reference to avoid TDZ issues
    const bias = htfBias; // Create local reference
    const effectiveTrend4h = ((mode === 'AGGRESSIVE' && trend4h === 'flat' && bias.confidence >= 70) ||
                              (mode === 'STANDARD' && trend4h === 'flat' && overrideUsed && bias && bias.confidence >= 60))
      ? (bias.direction === 'long' ? 'uptrend' : bias.direction === 'short' ? 'downtrend' : trend4h)
      : trend4h;
  
  // PRD 3.2: Long Setup Requirements
  if (effectiveTrend4h === 'uptrend') {
    direction = 'long';
    setupValid = true;
    
    // Check: Price retracing toward 21 EMA
    if (pullbackState === 'OVEREXTENDED') {
      invalidationReasons.push('Price too far from 21 EMA');
      setupValid = false;
    }
    
    // Check: 1h structure not breaking down
    const trend1h = normalizeTrend(tf1h?.indicators?.analysis?.trend);
    if (tf1h && trend1h === 'downtrend') {
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
  else if (effectiveTrend4h === 'downtrend') {
    direction = 'short';
    setupValid = true;
    
    // Check: Price retracing toward 21 EMA
    if (pullbackState === 'OVEREXTENDED') {
      invalidationReasons.push('Price too far from 21 EMA');
      setupValid = false;
    }
    
    // Check: 1h structure showing lower highs
    const trend1hShort = normalizeTrend(tf1h?.indicators?.analysis?.trend);
    if (tf1h && trend1hShort === 'uptrend') {
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
    const rawSignal = {
      symbol,
      direction: 'flat',
      reason: invalidationReasons.join('; ') || 'Setup requirements not met',
      confidence: 0,
      valid: false,
      setupType: '4h',
      selectedStrategy: 'NO_TRADE',
      strategiesChecked: ['SWING', 'TREND_4H'],
      trend: {
        '4h': trend4h.toLowerCase(),
        '1h': tf1h ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown'
      }
    };
    return normalizeToCanonical(rawSignal, analysis, mode);
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
  
  // Calculate entry zone - AGGRESSIVE mode ALWAYS uses aggressive entries
  let entryZone, entryType = 'pullback';
  
  // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
  if (mode === 'AGGRESSIVE') {
    const aggressiveZone = calculateAggressiveEntryZone(currentPrice, direction);
    if (aggressiveZone) {
      entryZone = aggressiveZone;
      entryType = 'breakout'; // Mark as breakout since it's ahead of price
    } else {
      // Fallback: use current price ±0.05%
      entryZone = direction === 'long' 
        ? { min: currentPrice * 1.0001, max: currentPrice * 1.0005 }
        : { min: currentPrice * 0.9995, max: currentPrice * 0.9999 };
      entryType = 'breakout';
    }
  } else {
    // STANDARD mode: Prioritize breakout entry when conditions are met
    const swingLevel = direction === 'long' 
      ? (tf4h.structure?.swingHigh || tf1h?.structure?.swingHigh)
      : (tf4h.structure?.swingLow || tf1h?.structure?.swingLow);
    const stoch4hForBreakout = tf4h.indicators?.stochRSI;
    
    // Prioritize breakout entry - check if price is near swing level with momentum
    if (swingLevel && stoch4hForBreakout && isBreakoutConfirmed(currentPrice, swingLevel, direction, stoch4hForBreakout)) {
      const breakoutZone = calculateBreakoutEntryZone(swingLevel, direction, currentPrice);
      if (breakoutZone) {
        entryZone = breakoutZone;
        entryType = 'breakout';
      } else {
        entryZone = calculateEntryZone(ema21, direction);
      }
    } else {
      // Use pullback entry only if breakout conditions not met
      entryZone = calculateEntryZone(ema21, direction);
    }
  }
  
  const entryMid = (entryZone.min + entryZone.max) / 2;
  const sltp = calculateSLTP(entryMid, direction, allStructures, setupType, rrTargets);
  
  // Calculate confidence with hierarchical weighting system (pass strategy name and filters)
  const strategyName = setupType === 'Scalp' ? 'SCALP_1H' : 'TREND_4H';
  const confidenceResult = calculateConfidenceWithHierarchy(
    analysis, 
    direction, 
    mode,
    strategyName,  // Strategy name for base confidence
    marketData,   // Volume quality filter
    dflowData      // dFlow alignment
  );
  let confidence = confidenceResult.confidence;
  let penaltiesApplied = [...confidenceResult.penaltiesApplied];
  const capsApplied = confidenceResult.capsApplied;
  const confidenceExplanation = confidenceResult.explanation;
  const dflowNote = confidenceResult.dflowNote || null;
  const volumeNote = confidenceResult.volumeNote || null;
  
  // Apply EMA distance penalty (replaces hard filter)
  const emaDistance = Math.abs(currentPrice - ema21) / currentPrice;
  if (emaDistance > 0.02) {
    // >2% still blocked
    return normalizeToCanonical({
      valid: false,
      direction: 'NO_TRADE',
      confidence,
      reason: `Setup rejected: price too far from EMA21 (${(emaDistance * 100).toFixed(2)}% > 2%)`,
      entryZone: { min: null, max: null },
      stopLoss: null,
      invalidationLevel: null,
      targets: [],
      riskReward: { tp1RR: null, tp2RR: null },
      validationErrors: []
    }, analysis, mode);
  } else if (emaDistance > 0.01) {
    // 1-2% = penalty
    confidence -= 3;
    penaltiesApplied.push({
      layer: 'entry',
      reason: `EMA distance penalty: ${(emaDistance * 100).toFixed(2)}% from 21 EMA (1-2% range)`,
      multiplier: 0.97
    });
  }
  
  // Global minimum confidence threshold
  const minConfidenceSafe = 60;
  const minConfidenceAggressive = 50;
  const minConfidence = mode === 'STANDARD' ? minConfidenceSafe : minConfidenceAggressive;
  
  // AGGRESSIVE mode: Allow override if confidence is high even if some direction conditions not met
  let override = false;
  let notes = [];
  // htfBias already computed above at line 1704 - reuse it, don't redeclare
  // Check if we should allow override in AGGRESSIVE mode
  if (mode === 'AGGRESSIVE' && confidence >= 65 && htfBias && htfBias.direction === direction) {
    // Allow trade with override tag
    override = true;
    notes.push('Direction conditions softened - high confidence override applied');
    penaltiesApplied.push({
      layer: 'override',
      reason: 'Direction softened due to high confidence (≥65%) and HTF bias alignment',
      multiplier: 1.0
    });
  }
  
  // Fuzzy tolerance: Allow ±1% if HTF bias aligns (for SCALP_1H and other strategies)
  const fuzzyTolerance = 1.0; // Allow 1% below minimum if HTF bias matches
  const withinFuzzyRange = confidence >= (minConfidence - fuzzyTolerance) && confidence < minConfidence;
  if (withinFuzzyRange && htfBias && htfBias.direction === direction && htfBias.confidence >= 60) {
    override = true;
    notes.push(`Fuzzy override: confidence ${confidence.toFixed(1)}% within ${fuzzyTolerance}% of minimum ${minConfidence}% with HTF bias alignment`);
    penaltiesApplied.push({
      layer: 'override',
      reason: `Fuzzy tolerance applied: confidence ${confidence.toFixed(1)}% (within ${fuzzyTolerance}% of ${minConfidence}%) with HTF bias ${htfBias.direction} (${htfBias.confidence}%)`,
      multiplier: 1.0
    });
  }
  
  if (confidence < minConfidence && !override) {
    return normalizeToCanonical({
      valid: false,
      direction: 'NO_TRADE',
      confidence,
      reason: `Setup rejected: confidence ${confidence.toFixed(1)}% below minimum ${minConfidence}%`,
      entryZone: { min: null, max: null },
      stopLoss: null,
      invalidationLevel: null,
      targets: [],
      riskReward: { tp1RR: null, tp2RR: null },
      validationErrors: []
    }, analysis, mode);
  }
  
  // Build reason summary (include confidence explanation)
  const reasonSummary = buildReasonSummary(analysis, direction, confidence);
  const enhancedReason = confidenceExplanation ? `${reasonSummary} [${confidenceExplanation}]` : reasonSummary;
  
  // Build trend object
  const trendObj = {
    '4h': trend4h ? (typeof trend4h === 'string' ? trend4h.toLowerCase() : 'unknown') : 'unknown',
    '1h': tf1h?.indicators?.analysis?.trend ? (typeof tf1h.indicators.analysis.trend === 'string' ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown') : 'unknown',
    '15m': tf15m?.indicators?.analysis?.trend ? (typeof tf15m.indicators.analysis.trend === 'string' ? tf15m.indicators.analysis.trend.toLowerCase() : 'unknown') : 'unknown',
    '5m': tf5m?.indicators?.analysis?.trend ? (typeof tf5m.indicators.analysis.trend === 'string' ? tf5m.indicators.analysis.trend.toLowerCase() : 'unknown') : 'unknown'
  };
  
  // Build stoch object
  const stochObj = {
    '4h': analyzeStochState(tf4h.indicators.stochRSI),
    '1h': tf1h ? analyzeStochState(tf1h.indicators.stochRSI) : null,
    '15m': tf15m ? analyzeStochState(tf15m.indicators.stochRSI) : null,
    '5m': tf5m ? analyzeStochState(tf5m.indicators.stochRSI) : null
  };
  
  // VALIDATE: Ensure all required fields are present before creating signal
  if (!entryZone || !sltp || !sltp.stopLoss || !sltp.invalidationLevel || 
      !sltp.targets || !sltp.targets[0] || isNaN(sltp.targets[0])) {
    // If any required field is missing, return NO_TRADE
    const rawSignal = {
      symbol,
      direction: 'NO_TRADE',
      setupType: '4h',
      selectedStrategy: 'NO_TRADE',
      strategiesChecked: ['SWING', 'TREND_4H'],
      confidence: 0,
      valid: false,
      reason_summary: '4H trend setup failed validation - missing required fields',
      entry_zone: { min: null, max: null },
      stop_loss: null,
      invalidation_level: null,
      targets: [null, null],
      risk_reward: { tp1RR: null, tp2RR: null },
      risk_amount: null
    };
    return normalizeToCanonical(rawSignal, analysis, mode);
  }
  
  const rawSignal = {
    symbol,
    direction,
    setupType: setupType,
    selectedStrategy: 'TREND_4H',
    strategiesChecked: ['SWING', 'TREND_4H'],
    entryType: entryType, // 'pullback' or 'breakout'
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
    confidence: Math.round(confidence), // Already 0-100 scale, just round
    reason_summary: enhancedReason || reasonSummary,
    penaltiesApplied: penaltiesApplied,
    capsApplied: capsApplied,
    explanation: confidenceExplanation,
    override: override || false, // Mark if relaxed conditions were used
    notes: notes.length > 0 ? notes : undefined, // Array of notes about relaxed conditions
    valid: true, // Only set to true after all fields validated
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
  return normalizeToCanonical(rawSignal, analysis, mode);
  } // End of 4H trend play
  
  // PRIORITY 3: TREND_RIDER (after TREND_4H, before SCALP_1H)
  if (setupType === 'TrendRider' || setupType === 'auto') {
    const trendRiderSignal = evaluateTrendRider(analysis, currentPrice, mode, marketData, dflowData);
    if (trendRiderSignal && trendRiderSignal.valid) {
      // If valid, return normalized signal
      const rawSignal = {
        ...trendRiderSignal,
        symbol,
        setupType: 'TrendRider',
        entry_zone: trendRiderSignal.entryZone,
        stop_loss: trendRiderSignal.stopLoss,
        invalidation_level: trendRiderSignal.invalidationLevel,
        targets: trendRiderSignal.targets,
        risk_reward: trendRiderSignal.riskReward,
        risk_amount: trendRiderSignal.riskAmount
      };
      return normalizeToCanonical(rawSignal, analysis, mode);
    }
    // If invalid or null, continue to next strategy (will be handled by normalizeStrategyResult)
  }
  
  // PRIORITY 4: Try 1H Scalp (works even when 4H is FLAT)
  if ((setupType === 'Scalp' || setupType === 'auto') && tf1h && tf15m) {
    const trend1h = tf1h.indicators?.analysis?.trend;
    const dist1h = tf1h.indicators?.analysis?.distanceFrom21EMA;
    const dist15m = tf15m.indicators?.analysis?.distanceFrom21EMA;
    const pullbackState1h = tf1h.indicators?.analysis?.pullbackState;
    const pullbackState15m = tf15m.indicators?.analysis?.pullbackState;
    
    // Normalize 1H trend
    const trend1hNorm = normalizeTrend(trend1h);
    
    // Need 1H trend (not FLAT)
    if (trend1hNorm && trend1hNorm !== 'flat') {
      const isLong = trend1hNorm === 'uptrend';
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
          
          // Entry zone calculation - AGGRESSIVE mode ALWAYS uses aggressive entries
          let entryZone, entryType = 'pullback';
          
          // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
          if (mode === 'AGGRESSIVE') {
            const aggressiveZone = calculateAggressiveEntryZone(currentPrice, direction);
            if (aggressiveZone) {
              entryZone = aggressiveZone;
              entryType = 'breakout'; // Mark as breakout since it's ahead of price
            } else {
              // Fallback: use current price ±0.05%
              entryZone = direction === 'long' 
                ? { min: currentPrice * 1.0001, max: currentPrice * 1.0005 }
                : { min: currentPrice * 0.9995, max: currentPrice * 0.9999 };
              entryType = 'breakout';
            }
          } else {
            // STANDARD mode: Prioritize breakout entry when conditions are met
            const swingLevel = direction === 'long' 
              ? (tf1h.structure?.swingHigh || tf15m?.structure?.swingHigh)
              : (tf1h.structure?.swingLow || tf15m?.structure?.swingLow);
            const stoch15mForBreakout = tf15m.indicators?.stochRSI;
            
            // Prioritize breakout entry - check if price is near swing level with momentum
            if (swingLevel && stoch15mForBreakout && isBreakoutConfirmed(currentPrice, swingLevel, direction, stoch15mForBreakout)) {
              const breakoutZone = calculateBreakoutEntryZone(swingLevel, direction, currentPrice);
              if (breakoutZone) {
                entryZone = breakoutZone;
                entryType = 'breakout';
              } else {
                entryZone = calculateEntryZone(ema21_1h, direction);
              }
            } else {
              // Use pullback entry only if breakout conditions not met
              entryZone = calculateEntryZone(ema21_1h, direction);
            }
          }
          
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
          
          // Use hierarchical confidence system for Scalp (pass strategy name and filters)
          const confidenceResult = calculateConfidenceWithHierarchy(
            analysis, 
            direction, 
            mode,
            'SCALP_1H',  // Strategy name for base confidence
            marketData,  // Volume quality filter
            dflowData     // dFlow alignment
          );
          let confidence = confidenceResult.confidence;
          const penaltiesApplied = confidenceResult.penaltiesApplied;
          const capsApplied = confidenceResult.capsApplied;
          const confidenceExplanation = confidenceResult.explanation;
          
          // Scalp-specific bonus: bias alignment
          const biasBonus = htfBias.direction === direction ? (htfBias.confidence * 0.1) : 0;
          confidence = Math.min(85, Math.round(confidence + biasBonus));
          
          // Block counter-trend scalps when HTF bias is strong (>= 70%)
          const strongBiasThreshold = 70;
          if (htfBias && htfBias.confidence >= strongBiasThreshold) {
            if (direction === 'long' && htfBias.direction === 'short') {
              return normalizeToCanonical({
                valid: false,
                direction: 'NO_TRADE',
                confidence: 0,
                reason: 'Counter-trend LONG scalp blocked by strong HTF short bias',
                entryZone: { min: null, max: null },
                stopLoss: null,
                invalidationLevel: null,
                targets: [],
                riskReward: { tp1RR: null, tp2RR: null },
                validationErrors: []
              }, analysis, mode);
            }
            if (direction === 'short' && htfBias.direction === 'long') {
              return normalizeToCanonical({
                valid: false,
                direction: 'NO_TRADE',
                confidence: 0,
                reason: 'Counter-trend SHORT scalp blocked by strong HTF long bias',
                entryZone: { min: null, max: null },
                stopLoss: null,
                invalidationLevel: null,
                targets: [],
                riskReward: { tp1RR: null, tp2RR: null },
                validationErrors: []
              }, analysis, mode);
            }
          }
          
          // Global minimum confidence threshold
          const minConfidenceSafe = 60;
          const minConfidenceAggressive = 50;
          const minConfidence = mode === 'STANDARD' ? minConfidenceSafe : minConfidenceAggressive;
          
          // Fuzzy tolerance: Allow ±1% if HTF bias aligns
          const htfBiasRaw = computeHTFBias(analysis);
          const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
          const fuzzyTolerance = 1.0;
          const withinFuzzyRange = confidence >= (minConfidence - fuzzyTolerance) && confidence < minConfidence;
          const allowFuzzyOverride = withinFuzzyRange && htfBias && htfBias.direction === direction && htfBias.confidence >= 60;
          
          if (confidence < minConfidence && !allowFuzzyOverride) {
            return normalizeToCanonical({
              valid: false,
              direction: 'NO_TRADE',
              confidence,
              reason: `Setup rejected: confidence ${confidence.toFixed(1)}% below minimum ${minConfidence}%`,
              entryZone: { min: null, max: null },
              stopLoss: null,
              invalidationLevel: null,
              targets: [],
              riskReward: { tp1RR: null, tp2RR: null },
              validationErrors: []
            }, analysis, mode);
          }
          
          const rawSignal = {
            symbol,
            direction,
            setupType: 'Scalp',
            selectedStrategy: 'SCALP_1H',
            strategiesChecked: ['SWING', 'TREND_4H', 'SCALP_1H'],
            entryType: entryType, // 'pullback' or 'breakout'
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
            confidence: Math.round(confidence), // Already 0-100 scale, just round
            reason_summary: confidenceExplanation ? 
              `1H ${trend1h.toLowerCase()} scalp with 15m pullback and Stoch alignment (HTF bias: ${htfBias.direction}, ${htfBias.confidence}%) [${confidenceExplanation}]` :
              `1H ${trend1h.toLowerCase()} scalp with 15m pullback and Stoch alignment (HTF bias: ${htfBias.direction}, ${htfBias.confidence}%)`,
            penaltiesApplied: penaltiesApplied,
            capsApplied: capsApplied,
            explanation: confidenceExplanation,
            invalidation: {
              level: parseFloat(sltp.invalidationLevel.toFixed(2)),
              description: '1H scalp invalidation – loss of pullback structure on 15m/5m'
            },
            valid: true, // Only set to true after all fields validated
            confluence: {
              trendAlignment: `${trend4h} on 4H, ${trend1h} on 1H`,
              stochMomentum: tf15m.indicators?.stochRSI?.condition || 'N/A',
              pullbackState: `1H: ${pullbackState1h || 'N/A'}, 15m: ${pullbackState15m || 'N/A'}`,
              liquidityZones: `1H: ${dist1h !== undefined ? Math.abs(dist1h).toFixed(2) : 'N/A'}%, 15m: ${dist15m !== undefined ? Math.abs(dist15m).toFixed(2) : 'N/A'}% from 21 EMA`,
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
          return normalizeToCanonical(rawSignal, analysis, mode);
        }
      }
    }
  }
  
  // PRIORITY 4: If AGGRESSIVE mode, try aggressive variants before giving up
  if (mode === 'AGGRESSIVE') {
    const aggressiveSignal = tryAggressiveStrategies(symbol, analysis, htfBias, thresholds);
    if (aggressiveSignal.valid) {
      const rawSignal = {
        ...aggressiveSignal,
        mode: 'AGGRESSIVE',
        riskProfile: 'HIGH',
        aggressiveUsed: true,
        htfBias: htfBias
      };
      return normalizeToCanonical(rawSignal, analysis, mode);
    }
  }
  
  // PRIORITY 5: No clean setup on any strategy (conservative or aggressive)
  const strategiesChecked = mode === 'AGGRESSIVE' 
    ? ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP', 'AGGRO_SCALP_1H', 'AGGRO_MICRO_SCALP']
    : ['SWING', 'TREND_4H', 'TREND_RIDER', 'SCALP_1H', 'MICRO_SCALP'];
    
  const rawSignal = {
    symbol,
    mode: mode,
    riskProfile: mode === 'AGGRESSIVE' ? 'HIGH' : 'NORMAL',
    aggressiveUsed: mode === 'AGGRESSIVE',
    direction: 'NO_TRADE',
    setupType: 'auto',
    selectedStrategy: 'NO_TRADE',
    strategiesChecked: strategiesChecked,
    confidence: 0,
    reason_summary: mode === 'AGGRESSIVE' 
      ? `No setup found (AGGRESSIVE mode checked: SWING / 4H Trend / 1H Scalp / Micro-Scalp / Aggro 1H Scalp / Aggro Micro-Scalp). 4H: ${trend4h}, 1H: ${tf1h?.indicators?.analysis?.trend || 'N/A'}. HTF bias: ${htfBias.direction} (${htfBias.confidence}% confidence)`
      : `No clean SWING / 4H Trend / 1H Scalp / Micro-Scalp setup. 4H: ${trend4h}, 1H: ${tf1h?.indicators?.analysis?.trend || 'N/A'}. HTF bias: ${htfBias.direction} (${htfBias.confidence}% confidence)`,
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
      liquidityZones: tf4h.indicators?.analysis?.distanceFrom21EMA ? 
        `${Math.abs(tf4h.indicators.analysis.distanceFrom21EMA).toFixed(2)}% from 4H 21 EMA` : 
        'Awaiting price positioning data',
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },
    conditionsRequired: [
      `⚠ Awaiting clean setup`,
      `• Swing: Needs 3D/1D/4H structure (4H not FLAT)`,
      `• 4H Trend: Needs 4H trending (UP or DOWN)`,
      `• 1H Scalp: Needs 1H trending + 15m pullback + stoch aligned`,
      `• Micro-Scalp: Needs 1H trending + 15m/5m within ±0.25% of EMA21`
    ],
    trend: {
      '4h': trend4h ? (typeof trend4h === 'string' ? trend4h.toLowerCase() : 'unknown') : 'unknown',
      '1h': tf1h?.indicators?.analysis?.trend ? (typeof tf1h.indicators.analysis.trend === 'string' ? tf1h.indicators.analysis.trend.toLowerCase() : 'unknown') : 'unknown',
      '15m': tf15m?.indicators?.analysis?.trend ? (typeof tf15m.indicators.analysis.trend === 'string' ? tf15m.indicators.analysis.trend.toLowerCase() : 'unknown') : 'unknown',
      '5m': tf5m?.indicators?.analysis?.trend ? (typeof tf5m.indicators.analysis.trend === 'string' ? tf5m.indicators.analysis.trend.toLowerCase() : 'unknown') : 'unknown'
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
  return normalizeToCanonical(rawSignal, analysis, mode);
}

/**
 * Evaluate Micro-Scalp Strategy
 * Independent LTF mean-reversion system (disregards 4H trend entirely)
 * Focuses on 1H/15m/5m alignment with tight EMA confluence
 * @param {Object} multiTimeframeData - All timeframe data
 * @returns {Object} Micro-scalp signal or null
 */
function evaluateMicroScalp(multiTimeframeData, marketData = null, dflowData = null, overrideUsed = false) {
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
  // Normalize 1H trend
  const trend1hNorm = normalizeTrend(trend1h);
  
  // 1H must be trending (not FLAT)
  if (trend1hNorm === 'flat') {
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
  if (trend1hNorm === 'uptrend') {
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
  if (trend1hNorm === 'downtrend') {
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
  
  // Use hierarchical confidence system for MicroScalp (pass strategy name and filters)
  const confidenceResult = calculateConfidenceWithHierarchy(
    multiTimeframeData, 
    direction, 
    'STANDARD', // MicroScalp always uses STANDARD mode
    'MICRO_SCALP',  // Strategy name for base confidence
    marketData,     // Volume quality filter
    dflowData        // dFlow alignment
  );
  
  // Base confidence from hierarchy, then apply MicroScalp-specific adjustments
  let confidence = confidenceResult.confidence || 0;
  const dist15m = Math.abs(pullback15m.distanceFrom21EMA || 0);
  const dist5m = Math.abs(pullback5m.distanceFrom21EMA || 0);
  const avgDist = (dist15m + dist5m) / 2;
  // Adjust based on tight confluence (bonus for tight pullbacks)
  const confluenceBonus = avgDist < 0.5 ? 5 : avgDist < 1.0 ? 3 : 0;
  confidence = Math.max(60, Math.min(75, confidence + confluenceBonus));
  
  // Volume quality soft block for MICRO_SCALP
  if (marketData && marketData.volumeQuality === 'LOW' && confidence < 60) {
    result.eligible = false;
    result.signal = null;
    return result; // Soft block: return no signal if volume quality too low
  }
  
  // Build signal - ENSURE ALL FIELDS ARE PRESENT BEFORE SETTING valid=true
  result.signal = {
    valid: true,
    direction: direction,
    setupType: 'MicroScalp',
    confidence: Math.round(confidence), // 0-100 scale, round to integer
    penaltiesApplied: confidenceResult.penaltiesApplied || [],
    capsApplied: confidenceResult.capsApplied || [],
    explanation: confidenceResult.explanation || '',
    entryType: 'pullback', // MICRO_SCALP uses pullback-only entries
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

/**
 * Evaluate Trend Rider Setup
 * Catch and ride strong trends using 4H as bias, 1H as execution,
 * and 15m/5m for timing. Earlier entries than SWING / deep pullbacks.
 * 
 * @param {Object} multiTimeframeData - All timeframe data (analysis object)
 * @param {number} currentPrice       - Current market price
 * @param {string} mode               - STANDARD or AGGRESSIVE
 * @returns {Object|null} Strategy signal or null
 */
export function evaluateTrendRider(multiTimeframeData, currentPrice, mode = 'STANDARD', marketData = null, dflowData = null, overrideUsed = false) {
  if (!multiTimeframeData) return null;

  const tf4h  = multiTimeframeData['4h'];
  const tf1h  = multiTimeframeData['1h'];
  const tf15m = multiTimeframeData['15m'];
  const tf5m  = multiTimeframeData['5m'];

  // Guard: need core timeframes
  if (!tf4h || !tf1h || !tf15m || !tf5m) return null;

  // ---- Extract indicators safely ----
  const trend4h   = normalizeTrend(tf4h.indicators?.analysis?.trend);
  const trend1h   = normalizeTrend(tf1h.indicators?.analysis?.trend);
  const trend15m  = normalizeTrend(tf15m.indicators?.analysis?.trend);
  const trend5m   = normalizeTrend(tf5m.indicators?.analysis?.trend);

  const pullback4h = {
    state: tf4h.indicators?.analysis?.pullbackState,
    dist:  tf4h.indicators?.analysis?.distanceFrom21EMA
  };

  const pullback1h = {
    state: tf1h.indicators?.analysis?.pullbackState,
    dist:  tf1h.indicators?.analysis?.distanceFrom21EMA
  };

  const pullback15m = {
    state: tf15m.indicators?.analysis?.pullbackState,
    dist:  tf15m.indicators?.analysis?.distanceFrom21EMA
  };

  const pullback5m = {
    state: tf5m.indicators?.analysis?.pullbackState,
    dist:  tf5m.indicators?.analysis?.distanceFrom21EMA
  };

  const ema21_4h  = tf4h.indicators?.ema?.ema21;
  const ema21_1h  = tf1h.indicators?.ema?.ema21;
  const ema200_1h = tf1h.indicators?.ema?.ema200;

  const stoch4h = tf4h.indicators?.stochRSI || {};
  const stoch1h = tf1h.indicators?.stochRSI || {};
  const stoch15m = tf15m.indicators?.stochRSI || {};
  const stoch5m  = tf5m.indicators?.stochRSI  || {};

  const swing4h = tf4h.structure || {};
  const swing1h = tf1h.structure || {};
  const swing15m = tf15m.structure || {};
  const swing5m  = tf5m.structure || {};

  // Core data guards
  if (!ema21_4h || !ema21_1h || !ema200_1h) return null;

  // ---- HTF Bias ----
  // Compute HTF bias with fallback to prevent null reference
  const htfBiasRaw = computeHTFBias(multiTimeframeData);
  const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
  
  if (!htfBias || !htfBias.direction || htfBias.direction === 'neutral') {
    return invalidNoTrade('TrendRider: No HTF bias direction');
  }

  // Require decent bias confidence; allow looser in AGGRESSIVE
  const minBiasConfidence = (mode === 'AGGRESSIVE') ? 55 : 60; // Lowered from 65 to 60 for STANDARD mode
  if (htfBias.confidence < minBiasConfidence) {
    return invalidNoTrade(`TrendRider: HTF bias confidence ${htfBias.confidence}% below minimum ${minBiasConfidence}%`);
  }

  // ---- Gatekeepers: Define effective 4H trend based on bias + stoch ----
  let effectiveTrend4h = trend4h;

  // In AGGRESSIVE mode, allow FLAT 4H if HTF bias is strong and stoch supports it
  if (mode === 'AGGRESSIVE' && trend4h === 'flat') {
    if (htfBias.confidence >= 70) {
      if (htfBias.direction === 'long' && (stoch4h.condition === 'BULLISH' || stoch4h.k < 40)) {
        effectiveTrend4h = 'uptrend';
      }
      if (htfBias.direction === 'short' && (stoch4h.condition === 'BEARISH' || stoch4h.k > 60)) {
        effectiveTrend4h = 'downtrend';
      }
    }
  }

  // If still FLAT in STANDARD mode, block this strategy
  if (mode === 'STANDARD' && effectiveTrend4h === 'flat') {
    return invalidNoTrade('TrendRider: 4H trend is FLAT (STANDARD mode requires clear trend)');
  }

  // ---- Decide direction from bias + 4H/1H ----
  let direction = null;
  let reason = '';

  // Helper predicates
  const isBull = (trend) => trend === 'uptrend';
  const isBear = (trend) => trend === 'downtrend';

  // LONG candidate
  const longCandidate =
    htfBias.direction === 'long' &&
    (isBull(effectiveTrend4h) || (mode === 'AGGRESSIVE' && trend4h !== 'downtrend')) &&
    (isBull(trend1h) || (trend1h === 'flat' && ema21_1h < ema200_1h === false)) && // Allow 1H flat if structurally up
    ema21_1h && ema200_1h &&
    currentPrice > ema21_1h &&
    currentPrice > ema21_4h &&
    currentPrice > ema200_1h;

  // SHORT candidate (with loosened 1H condition)
  const shortCandidate =
    htfBias.direction === 'short' &&
    (isBear(effectiveTrend4h) || (mode === 'AGGRESSIVE' && trend4h !== 'uptrend')) &&
    (isBear(trend1h) || (trend1h === 'flat' && ema21_1h < ema200_1h)) && // Allow 1H flat if structurally down (EMA21 < EMA200)
    ema21_1h && ema200_1h &&
    currentPrice < ema21_1h &&
    currentPrice < ema21_4h &&
    currentPrice < ema200_1h;

  if (!longCandidate && !shortCandidate) {
    return invalidNoTrade('TrendRider: Direction conditions not met');
  }

  // ---- Pullback / continuation logic (LOOSENED) ----
  // We allow:
  // - Shallow pullbacks (RETRACING / ENTRY_ZONE) on 1H
  // - Not extremely overextended vs 4H EMA (so you're not buying a top)
  const maxOverextensionPctSafe = 2.5;   // SAFE: price within 2.5% of 4H EMA21
  const maxOverextensionPctAggressive = 3.5; // AGGRESSIVE: price within 3.5% of 4H EMA21
  const maxOverextensionPct = (mode === 'AGGRESSIVE') ? maxOverextensionPctAggressive : maxOverextensionPctSafe;

  const abs4hDist = Math.abs(pullback4h.dist || 0);
  const abs1hDist = Math.abs(pullback1h.dist || 0);

  const valid1hPullback =
    pullback1h.state === 'RETRACING' ||
    pullback1h.state === 'ENTRY_ZONE' ||
    (mode === 'AGGRESSIVE' && abs1hDist <= 5);

  const valid4hDist = abs4hDist <= maxOverextensionPct;

  if (!valid1hPullback || !valid4hDist) {
    return invalidNoTrade(`TrendRider: Pullback conditions not met (4H dist: ${abs4hDist.toFixed(2)}%, 1H dist: ${abs1hDist.toFixed(2)}%)`);
  }

  // ---- LTF confirmation (15m / 5m) ----
  const stoch15_k = stoch15m.k ?? 50;
  const stoch15_cond = stoch15m.condition ?? 'NEUTRAL';
  const stoch5_k  = stoch5m.k ?? 50;
  const stoch5_cond  = stoch5m.condition ?? 'NEUTRAL';
  const stoch1h_k = stoch1h.k ?? 50;
  const stoch1h_cond = stoch1h.condition ?? 'NEUTRAL';

  let ltfOk = false;

  if (longCandidate) {
    const fifteenOk = (stoch15_cond === 'BULLISH' || stoch15_cond === 'OVERSOLD' || stoch15_k < 40);
    const fiveOk    = (stoch5_cond  === 'BULLISH' || stoch5_cond  === 'OVERSOLD' || stoch5_k  < 40);
    ltfOk = fifteenOk && fiveOk;
  }

  if (shortCandidate) {
    // For shorts: 1H must be overbought, 15m/5m can be neutral or overbought
    const oneHourOk = stoch1h_cond === 'OVERBOUGHT' || stoch1h_k > 60;
    const fifteenOk = (stoch15_cond === 'BEARISH' || stoch15_cond === 'OVERBOUGHT' || stoch15_cond === 'NEUTRAL' || stoch15_k > 60);
    const fiveOk    = (stoch5_cond  === 'BEARISH' || stoch5_cond  === 'OVERBOUGHT' || stoch5_cond  === 'NEUTRAL' || stoch5_k  > 60);
    ltfOk = oneHourOk && (fifteenOk || fiveOk); // At least one of 15m/5m must be ok
  }

  if (!ltfOk) {
    return invalidNoTrade(`TrendRider: LTF Stoch conditions not aligned (1H: ${stoch1h_cond}, 15m: ${stoch15_cond}, 5m: ${stoch5_cond})`);
  }

  // ---- Set direction + reason ----
  if (longCandidate) {
    direction = 'long';
    reason = 'Trend Rider LONG: HTF bias + 4H/1H uptrend, price above 21/200 EMAs with shallow pullback and bullish 15m/5m momentum.';
  } else if (shortCandidate) {
    direction = 'short';
    reason = 'Trend Rider SHORT: HTF bias + 4H/1H downtrend, price below 21/200 EMAs with shallow pullback and bearish 15m/5m momentum.';
  }

  if (!direction) return null;

  // ---- Entry Zone - AGGRESSIVE mode ALWAYS uses aggressive entries ----
  let entryMin, entryMax, entryType = 'pullback';
  
  // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
  if (mode === 'AGGRESSIVE') {
    const aggressiveZone = calculateAggressiveEntryZone(currentPrice, direction);
    if (aggressiveZone) {
      entryMin = aggressiveZone.min;
      entryMax = aggressiveZone.max;
      entryType = 'breakout'; // Mark as breakout since it's ahead of price
    } else {
      // Fallback: use current price ±0.05%
      if (direction === 'long') {
        entryMin = currentPrice * 1.0001;
        entryMax = currentPrice * 1.0005;
      } else {
        entryMin = currentPrice * 0.9995;
        entryMax = currentPrice * 0.9999;
      }
      entryType = 'breakout';
    }
  } else {
    // STANDARD mode: Prioritize breakout entry when conditions are met
    const swingLevel = direction === 'long' 
      ? (swing4h.swingHigh || swing1h.swingHigh)
      : (swing4h.swingLow || swing1h.swingLow);
    const stoch4hForBreakout = tf4h.indicators?.stochRSI;
    
    // Prioritize breakout entry - check if price is near swing level with momentum
    if (swingLevel && stoch4hForBreakout && isBreakoutConfirmed(currentPrice, swingLevel, direction, stoch4hForBreakout)) {
      const breakoutZone = calculateBreakoutEntryZone(swingLevel, direction, currentPrice);
      if (breakoutZone) {
        entryMin = breakoutZone.min;
        entryMax = breakoutZone.max;
        entryType = 'breakout';
      } else {
        // Fallback to pullback entry
        const entryAnchor = ema21_4h;
        const baseZone = calculateEntryZone(entryAnchor, direction);
        entryMin = baseZone.min;
        entryMax = baseZone.max;
      }
    } else {
      // Use pullback entry zone only if breakout conditions not met
      const entryAnchor = ema21_4h;
      const baseZone = calculateEntryZone(entryAnchor, direction);
      entryMin = baseZone.min;
      entryMax = baseZone.max;
    }
  }

  const entryMid = (entryMin + entryMax) / 2;

  // ---- SL/TP using 1H + 4H structure, medium R:R ----
  const allStructures = {
    '1h': {
      swingHigh: swing1h.swingHigh ?? swing4h.swingHigh ?? swing15m.swingHigh ?? swing5m.swingHigh ?? null,
      swingLow:  swing1h.swingLow  ?? swing4h.swingLow  ?? swing15m.swingLow  ?? swing5m.swingLow  ?? null
    },
    '4h': swing4h,
    '15m': swing15m,
    '5m': swing5m
  };

  const rrTargets = [2.0, 3.5]; // Trend riding, not tiny scalps

  const sltp = calculateSLTP(
    entryMid,
    direction,
    allStructures,
    'TrendRider',
    rrTargets
  );

  // ---- Confidence scoring via hierarchy + small bonuses ----
  const confidenceResult = calculateConfidenceWithHierarchy(
    multiTimeframeData, 
    direction, 
    mode,
    'TREND_RIDER',  // Strategy name for base confidence
    marketData,     // Volume quality filter
    dflowData        // dFlow alignment
  );
  let confidence = confidenceResult.confidence || 0;

  // Mild bonus if everything is strongly aligned
  let alignmentBonus = 0;
  const macroAligned = (htfBias.direction === direction && htfBias.confidence >= 70);
  const primaryAligned = (
    ((direction === 'long' && isBull(effectiveTrend4h) && (isBull(trend1h) || (trend1h === 'flat' && ema21_1h > ema200_1h))) ||
     (direction === 'short' && isBear(effectiveTrend4h) && (isBear(trend1h) || (trend1h === 'flat' && ema21_1h < ema200_1h))))
  );

  if (macroAligned && primaryAligned) alignmentBonus += 5;
  if (Math.abs(abs1hDist) <= 1.5) alignmentBonus += 3; // nice, tight pullback

  confidence = Math.min(90, confidence + alignmentBonus);

  // Global minimum confidence threshold
  const minConfidenceSafe = 60;
  const minConfidenceAggressive = 50;
  const minConfidence = mode === 'STANDARD' ? minConfidenceSafe : minConfidenceAggressive;

  if (confidence < minConfidence) {
    return invalidNoTrade(`TrendRider: Confidence ${confidence.toFixed(1)}% below minimum ${minConfidence}%`);
  }

  // ---- Build canonical signal ----
  const signal = {
    valid: true,
    direction,
    setupType: 'TrendRider',
    selectedStrategy: 'TREND_RIDER',
    strategiesChecked: ['TREND_RIDER'],
    confidence: Math.round(confidence),
    reason,
    reason_summary: confidenceResult.explanation
      ? `${reason} [${confidenceResult.explanation}]`
      : reason,
    penaltiesApplied: confidenceResult.penaltiesApplied || [],
    capsApplied: confidenceResult.capsApplied || [],
    explanation: confidenceResult.explanation || '',
    entryType: entryType, // 'pullback' or 'breakout'

    entryZone: {
      min: parseFloat(entryMin.toFixed(2)),
      max: parseFloat(entryMax.toFixed(2))
    },
    stopLoss: parseFloat(sltp.stopLoss.toFixed(2)),
    invalidationLevel: parseFloat(sltp.invalidationLevel.toFixed(2)),
    targets: (sltp.targets || []).map(t => parseFloat(t.toFixed(2))),
    riskReward: {
      tp1RR: sltp.rrTargets?.[0] ?? rrTargets[0],
      tp2RR: sltp.rrTargets?.[1] ?? rrTargets[1]
    },
    riskAmount: parseFloat((sltp.riskAmount ?? 0).toFixed(2)),

    invalidation: {
      level: parseFloat(sltp.invalidationLevel.toFixed(2)),
      description: 'Trend Rider invalidated if 1H/4H structure breaks against trend.'
    },

    confluence: {
      trendAlignment: `HTF bias ${htfBias.direction} (${htfBias.confidence}%), 4H trend: ${effectiveTrend4h}, 1H trend: ${trend1h}`,
      stochMomentum: `15m stoch: ${stoch15_cond} (k=${stoch15_k.toFixed?.(1) ?? stoch15_k}), 5m stoch: ${stoch5_cond} (k=${stoch5_k.toFixed?.(1) ?? stoch5_k})`,
      pullbackState: `4H pullback: ${pullback4h.state} (${pullback4h.dist ?? 0}% from 21 EMA), 1H pullback: ${pullback1h.state} (${pullback1h.dist ?? 0}% from 21 EMA)`,
      liquidityZones: `Using 1H + 4H swings for SL/TP structure.`,
      htfConfirmation: `${htfBias.confidence}% confidence (${htfBias.source})`
    },

    conditionsRequired: [
      '✓ HTF bias aligned with 4H + 1H trend',
      '✓ Price above/below 4H & 1H 21/200 EMAs in trend direction',
      '✓ 1H pullback in RETRACING / ENTRY_ZONE (not hyper-extended)',
      '✓ 15m & 5m Stoch RSI aligned with trend (bullish for longs, bearish for shorts)',
      '✓ SL anchored to recent 1H/4H structure with 2R–3.5R targets'
    ],

    currentPrice: parseFloat(currentPrice.toFixed(2)),
    timestamp: new Date().toISOString(),
    htfBias
  };

  return signal;
}

/**
 * Evaluate ALL strategies for a symbol and mode
 * Returns a rich object with all strategies (even NO_TRADE ones)
 * @param {string} symbol - Trading symbol
 * @param {Object} multiTimeframeData - Multi-timeframe analysis data
 * @param {string} mode - STANDARD or AGGRESSIVE
 * @param {Object} marketData - Market data for volume quality and trade flow filters
 * @param {Object} dflowData - dFlow prediction market data for alignment check
 * @returns {Object} Rich strategy object with all strategies
 */
export function evaluateAllStrategies(symbol, multiTimeframeData, mode = 'STANDARD', marketData = null, dflowData = null) {
  console.log(`[evaluateAllStrategies] === START === ${symbol} mode=${mode}`);
  console.log(`[evaluateAllStrategies] multiTimeframeData keys:`, multiTimeframeData ? Object.keys(multiTimeframeData) : 'null');
  console.log(`[evaluateAllStrategies] marketData:`, marketData ? 'present' : 'null');
  console.log(`[evaluateAllStrategies] dflowData:`, dflowData ? 'present' : 'null');
  
  try {
  
  // Compute HTF bias early - needed for both STANDARD and AGGRESSIVE modes
  // Use fallback pattern to prevent null reference errors
  let htfBiasRaw = null;
  try {
    htfBiasRaw = computeHTFBias(multiTimeframeData);
  } catch (biasError) {
    console.error(`[evaluateAllStrategies] ${symbol} ERROR computing HTF bias:`, biasError.message);
  }
  
  // Always use fallback to prevent null reference exceptions
  const htfBias = htfBiasRaw ?? { direction: 'neutral', confidence: 0, source: 'fallback' };
  console.log(`[evaluateAllStrategies] ${symbol} HTF bias computed:`, htfBias);
  
  // Validate HTF bias exists before proceeding
  if (!htfBias || !htfBias.direction || htfBias.direction === 'neutral') {
    console.warn(`[evaluateAllStrategies] ${symbol} Missing or neutral HTF bias - strategies may be limited`);
  }
  
  const strategies = {
    SWING: null,
    TREND_4H: null,
    TREND_RIDER: null,
    SCALP_1H: null,
    MICRO_SCALP: null
  };
  
  // SAFE_MODE: Strict 4H trend gate - if 4H is FLAT, all strategies must be NO_TRADE
  const tf4h = multiTimeframeData['4h'];
  const trend4hRaw = tf4h?.indicators?.analysis?.trend;
  const trend4h = normalizeTrend(trend4hRaw);
  const is4HFlat = trend4h === 'flat';
  
  console.log(`[evaluateAllStrategies] ${symbol} 4H trend=${trend4hRaw} (normalized=${trend4h}), is4HFlat=${is4HFlat}`);
  
  // Track if override was used (for adding to strategy signals)
  let overrideUsed = false;
  let overrideNotes = []; // Store notes about why override was used
  
  if (mode === 'STANDARD' && is4HFlat) {
    // STANDARD mode: Check if we can override 4H FLAT block with strong alignment
    // htfBias already computed above - use it
    if (!htfBias || !htfBias.direction || htfBias.direction === 'neutral') {
      console.log(`[evaluateAllStrategies] ${symbol} STANDARD: No HTF bias available, blocking all strategies`);
      const flatReason = '4H trend is FLAT - no trade allowed per STANDARD mode rules (no HTF bias available)';
    strategies.SWING = createNoTradeStrategy('SWING', flatReason);
    strategies.TREND_4H = createNoTradeStrategy('TREND_4H', flatReason);
      strategies.TREND_RIDER = createNoTradeStrategy('TREND_RIDER', flatReason);
    strategies.SCALP_1H = createNoTradeStrategy('SCALP_1H', flatReason);
    strategies.MICRO_SCALP = createNoTradeStrategy('MICRO_SCALP', flatReason);
      return { strategies, bestSignal: null };
    }
    
    const tf1h = multiTimeframeData['1h'];
    const tf15m = multiTimeframeData['15m'];
    
    const trend1hRaw = tf1h?.indicators?.analysis?.trend;
    const trend15mRaw = tf15m?.indicators?.analysis?.trend;
    const trend1h = normalizeTrend(trend1hRaw);
    const trend15m = normalizeTrend(trend15mRaw);
    
    // Get price and EMA data for trend inference
    const price1h = tf1h?.indicators?.price?.current;
    const ema21_1h = tf1h?.indicators?.ema?.ema21;
    const ema200_1h = tf1h?.indicators?.ema?.ema200;
    const price15m = tf15m?.indicators?.price?.current;
    const ema21_15m = tf15m?.indicators?.ema?.ema21;
    const ema200_15m = tf15m?.indicators?.ema?.ema200;
    
    const stoch1h = tf1h?.indicators?.stochRSI || {};
    const stoch15m = tf15m?.indicators?.stochRSI || {};
    
    // SAFE mode override conditions (updated per requirements):
    // - HTF bias ≥ 60%
    // - 1H trend matches HTF bias direction (must be "up" for longs, "down" for shorts)
    // - 15m trend matches HTF bias direction (must be "up" for longs, "down" for shorts)
    // - 1H Stoch K < 60 for momentum confirmation (for longs), or > 40 for shorts
    const biasStrong = htfBias && typeof htfBias.confidence === 'number' && htfBias.confidence >= 60;
    const desiredDirection = htfBias?.direction; // 'long' or 'short'
    
    // Helper: Check if trend matches direction
    const isSameDirection = (trend, direction) => {
      if (!trend || !direction) return false;
      const trendLower = (trend || '').toLowerCase();
      if (direction === 'long') {
        return trendLower.includes('up') || trendLower === 'long';
      } else if (direction === 'short') {
        return trendLower.includes('down') || trendLower === 'short';
      }
      return false;
    };
    
    // Check 1H trend matches HTF bias direction
    const trend1hMatches = isSameDirection(trend1h, desiredDirection);
    
    // Check 15m trend matches HTF bias direction (both must match, not OR)
    const trend15mMatches = isSameDirection(trend15m, desiredDirection);
    
    // Check 1H momentum confirmation: Stoch K < 60 for longs, > 40 for shorts
    const stoch1hK = stoch1h?.k;
    const momentumOK = desiredDirection && typeof stoch1hK === 'number' ? (
      (desiredDirection === 'long' && stoch1hK < 60) || // Momentum confirmation for longs
      (desiredDirection === 'short' && stoch1hK > 40)    // Momentum confirmation for shorts
    ) : false; // Require momentum confirmation, don't default to true
    
    // Override allowed if: HTF bias ≥ 60%, 1H matches, 15m matches, AND momentum confirms
    const overrideEligible = biasStrong && trend1hMatches && trend15mMatches && momentumOK;
    
    // Debug logging
    console.log(`[evaluateAllStrategies] ${symbol} STANDARD override check:`, {
      biasStrong,
      htfBiasDirection: desiredDirection,
      htfBiasConfidence: htfBias?.confidence,
      trend1hRaw,
      trend1h,
      trend1hMatches,
      trend15mRaw,
      trend15m,
      trend15mMatches,
      stoch1hK,
      momentumOK: `stoch1hK=${stoch1hK}, required: ${desiredDirection === 'long' ? '< 60' : '> 40'}`,
      overrideEligible
    });
    
    if (!overrideEligible) {
      // SAFE_MODE: Block all trades when 4H is flat and override conditions not met
      const flatReason = '4H trend is FLAT - no trade allowed per STANDARD mode rules (override conditions not met)';
      console.log(`[evaluateAllStrategies] ${symbol} STANDARD: Blocking all strategies (4H flat, override conditions not met)`);
    strategies.SWING = createNoTradeStrategy('SWING', flatReason);
    strategies.TREND_4H = createNoTradeStrategy('TREND_4H', flatReason);
      strategies.TREND_RIDER = createNoTradeStrategy('TREND_RIDER', flatReason);
    strategies.SCALP_1H = createNoTradeStrategy('SCALP_1H', flatReason);
    strategies.MICRO_SCALP = createNoTradeStrategy('MICRO_SCALP', flatReason);
    
    return {
      strategies,
        bestSignal: null
    };
    } else {
      // Override allowed: Continue with strategy evaluation but mark as relaxed
      overrideUsed = true;
      overrideNotes = [
        `SAFE override: HTF bias + 1H/15m trend alignment`,
        `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`,
        `1H trend: ${trend1h} matches HTF bias direction`,
        `15m trend: ${trend15m} matches HTF bias direction`,
        `1H Stoch K: ${stoch1hK} (momentum confirmation)`
      ];
      console.log(`[evaluateAllStrategies] ${symbol} STANDARD: 4H flat but override conditions met (HTF bias: ${htfBias.direction} ${htfBias.confidence}%, 1H=${trend1h}, 15m=${trend15m}, stoch1hK=${stoch1hK})`);
      console.log(`[evaluateAllStrategies] ${symbol} STANDARD: Override notes:`, overrideNotes);
      console.log(`[evaluateAllStrategies] ${symbol} STANDARD: SAFE override triggered - allowing strategy evaluation to continue`);
    }
  }
  
  // Evaluate each strategy - ALWAYS evaluate all, even if they return NO_TRADE
  // Pass marketData and dflowData to all strategy evaluations
  // IMPORTANT: When override is used, strategies should allow 4H flat
  // We'll pass overrideUsed as part of the context, but strategies need to check it
  const swingResult = evaluateSwingSetup(multiTimeframeData, multiTimeframeData['4h']?.indicators?.price?.current || 0, mode, marketData, dflowData, overrideUsed);
  const trend4hResult = evaluateStrategy(symbol, multiTimeframeData, '4h', mode, marketData, dflowData, overrideUsed);
  const scalp1hResult = evaluateStrategy(symbol, multiTimeframeData, 'Scalp', mode, marketData, dflowData, overrideUsed);
  const microScalpResult = evaluateMicroScalp(multiTimeframeData, marketData, dflowData, overrideUsed);
  
  // TREND_RIDER: Evaluate directly to ensure it's always included
  const currentPrice = tf4h?.indicators?.price?.current || multiTimeframeData['1h']?.indicators?.price?.current || 0;
  // htfBias already computed above - use it
  const trendRiderRaw = evaluateTrendRider(multiTimeframeData, currentPrice, mode, marketData, dflowData, overrideUsed);
  
  // Normalize each to strategy format - always include, even if NO_TRADE
  // Pass mode so normalizeStrategyResult can handle AGGRESSIVE differently
  // If override was used in STANDARD mode, mark strategies with override flag and notes
  strategies.SWING = normalizeStrategyResult(swingResult, 'SWING', mode, overrideUsed, overrideNotes);
  strategies.TREND_4H = normalizeStrategyResult(trend4hResult, 'TREND_4H', mode, overrideUsed, overrideNotes);
  
  // TREND_RIDER: Wrap in signal format for normalizeStrategyResult (same pattern as other strategies)
  const trendRiderWrapped = trendRiderRaw ? {
    signal: trendRiderRaw
  } : null;
  strategies.TREND_RIDER = normalizeStrategyResult(trendRiderWrapped, 'TREND_RIDER', mode, overrideUsed, overrideNotes);
  
  strategies.SCALP_1H = normalizeStrategyResult(scalp1hResult, 'SCALP_1H', mode, overrideUsed, overrideNotes);
  
  // MicroScalp needs special handling
  if (microScalpResult && microScalpResult.eligible && microScalpResult.signal && microScalpResult.signal.valid) {
    strategies.MICRO_SCALP = normalizeMicroScalpResult(microScalpResult.signal, symbol);
  } else {
    strategies.MICRO_SCALP = createNoTradeStrategy('MICRO_SCALP', 
      microScalpResult && !microScalpResult.eligible 
        ? 'MicroScalp conditions not met - requires 1H trend + tight EMA confluence' 
        : 'No MicroScalp setup available');
  }
  
  // AGGRESSIVE_MODE: Force valid trades when HTF bias + lower TFs align strongly
  // IMPORTANT: This MUST run for AGGRESSIVE mode when 4H is flat to override SAFE blocking
  if (mode === 'AGGRESSIVE' && is4HFlat) {
    // htfBias already computed above with fallback - safe to use
    // Allow trades when HTF bias ≥ 60% and lower timeframes align (relaxed from 70%)
    if (htfBias.direction === 'neutral' || htfBias.confidence < 60) {
      console.warn(`[AGGRESSIVE_FORCE] ${symbol}: HTF bias insufficient (${htfBias.direction}, ${htfBias.confidence}%), cannot force trades`);
    } else {
    console.log(`[AGGRESSIVE_FORCE] ${symbol}: HTF bias=${htfBias.direction} (${htfBias.confidence}%), 4H flat, checking forcing conditions...`);
    console.log(`[AGGRESSIVE_FORCE] ${symbol}: marketData=${marketData ? 'present' : 'null'}, dflowData=${dflowData ? 'present' : 'null'}`);
    console.log(`[AGGRESSIVE_FORCE] ${symbol}: multiTimeframeData keys=`, Object.keys(multiTimeframeData || {}));
    console.log(`[TEST_CASE_B] ${symbol} AGGRESSIVE_MODE: 4H flat, HTF bias=${htfBias.direction} (${htfBias.confidence}%)`);
    const tf1h = multiTimeframeData['1h'];
    const tf15m = multiTimeframeData['15m'];
    const tf5m = multiTimeframeData['5m'];
    
    // Ensure we have data
    if (!tf1h || !tf15m) {
      console.error(`[AGGRESSIVE_FORCE] ${symbol}: Missing required timeframe data (1h=${!!tf1h}, 15m=${!!tf15m})`);
    }
    
    // Normalize trends to lowercase for comparison (handle both UPTREND/uptrend)
    const trend1hRaw = tf1h?.indicators?.analysis?.trend || 'UNKNOWN';
    const trend15mRaw = tf15m?.indicators?.analysis?.trend || 'UNKNOWN';
    const trend5mRaw = tf5m?.indicators?.analysis?.trend || 'UNKNOWN';
    
    const trend1h = trend1hRaw.toLowerCase().replace('trend', '').trim() || 'unknown';
    const trend15m = trend15mRaw.toLowerCase().replace('trend', '').trim() || 'unknown';
    const trend5m = trend5mRaw.toLowerCase().replace('trend', '').trim() || 'unknown';
    
    // Normalize to 'up', 'down', or 'flat'
    const trend1hNorm = trend1h.includes('up') ? 'uptrend' : trend1h.includes('down') ? 'downtrend' : 'flat';
    const trend15mNorm = trend15m.includes('up') ? 'uptrend' : trend15m.includes('down') ? 'downtrend' : 'flat';
    const trend5mNorm = trend5m.includes('up') ? 'uptrend' : trend5m.includes('down') ? 'downtrend' : 'flat';
    
    const stoch1h = tf1h?.indicators?.stochRSI || {};
    const stoch15m = tf15m?.indicators?.stochRSI || {};
    const stoch1m = multiTimeframeData['1m']?.indicators?.stochRSI || {};
    
    // Determine stoch states
    const stoch1hState = (stoch1h.k > 80 && stoch1h.d > 80) ? 'overbought' : 
                        (stoch1h.k < 20 && stoch1h.d < 20) ? 'oversold' : 'neutral';
    const stoch15mState = (stoch15m.k > 80 && stoch15m.d > 80) ? 'overbought' : 
                          (stoch15m.k < 20 && stoch15m.d < 20) ? 'oversold' : 'neutral';
    const stoch1mState = (stoch1m.k > 80 && stoch1m.d > 80) ? 'overbought' : 
                         (stoch1m.k < 20 && stoch1m.d < 20) ? 'oversold' : 'neutral';
    
    const currentPrice = tf4h?.indicators?.price?.current || tf1h?.indicators?.price?.current || 0;
    
    // REQUIRED LONG SETUP IN AGGRESSIVE_MODE (lowered threshold to 60% as per requirements)
    if (htfBias.direction === 'long' && htfBias.confidence >= 60 && 
        trend1hNorm === 'uptrend' && trend15mNorm === 'uptrend') {
      
      console.log(`[AGGRESSIVE_FORCE] ${symbol}: LONG conditions met! HTF=${htfBias.direction}(${htfBias.confidence}%), 1H=${trend1hNorm}, 15m=${trend15mNorm}`);
      
      // Choose best strategy: Prefer TREND_4H, then SCALP_1H, then MICRO_SCALP
      let chosenStrategy = null;
      let chosenName = null;
      
      // Try TREND_4H first - FORCE override (always create if conditions met)
      {
        const ema21_1h = tf1h?.indicators?.ema?.ema21 || currentPrice;
        const ema21_15m = tf15m?.indicators?.ema?.ema21 || currentPrice;
        const entryMid = (ema21_1h + ema21_15m) / 2;
        const entryZone = {
          min: entryMid * 0.995,
          max: entryMid * 1.005
        };
        
        const swingLow1h = tf1h?.indicators?.swingLow || ema21_1h * 0.98;
        const stopLoss = swingLow1h;
        const R = Math.abs(entryMid - stopLoss);
        
        const tp1 = entryMid + (R * 1.5);
        const tp2 = entryMid + (R * 3.0);
        
        // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
        const aggressiveEntryZone = calculateAggressiveEntryZone(currentPrice, 'long');
        chosenStrategy = {
          valid: true,
          direction: 'long',
          confidence: Math.min(100, htfBias.confidence),
          reason: `AGGRESSIVE: HTF bias long (${htfBias.confidence}%) + 1H/15m uptrend aligned, using lower TFs despite 4H flat`,
          entryType: 'breakout', // AGGRESSIVE forced trades use aggressive entry (close to price)
          override: true,
          notes: ['Override: AGGRESSIVE mode with HTF bias and short-term momentum', `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`, '1H and 15m trends aligned despite 4H flat', 'Aggressive entry: close to current price'],
          entryZone: aggressiveEntryZone ? {
            min: parseFloat(aggressiveEntryZone.min.toFixed(2)),
            max: parseFloat(aggressiveEntryZone.max.toFixed(2))
          } : {
            min: parseFloat((currentPrice * 1.0001).toFixed(2)),
            max: parseFloat((currentPrice * 1.0005).toFixed(2))
          },
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          invalidationLevel: parseFloat(stopLoss.toFixed(2)),
          targets: [parseFloat(tp1.toFixed(2)), parseFloat(tp2.toFixed(2))],
          riskReward: {
            tp1RR: 1.5,
            tp2RR: 3.0
          },
          penaltiesApplied: [],
          capsApplied: [],
          explanation: 'AGGRESSIVE mode: Forced trade when 4H is FLAT but HTF bias + lower TFs align',
          confluence: {
            trendAlignment: `HTF bias: ${htfBias.direction} (${htfBias.confidence}%), 1H: ${trend1hNorm}, 15m: ${trend15mNorm}`,
            stochMomentum: 'AGGRESSIVE forced entry',
            pullbackState: 'N/A',
            liquidityZones: 'N/A',
            htfConfirmation: `${htfBias.confidence}% confidence`
          },
          validationErrors: []
        };
        chosenName = 'TREND_4H';
      }
      
      // If TREND_4H not chosen, try SCALP_1H - FORCE override
      if (!chosenStrategy) {
        const ema21_1h = tf1h?.indicators?.ema?.ema21 || currentPrice;
        const entryMid = ema21_1h;
        const entryZone = {
          min: entryMid * 0.998,
          max: entryMid * 1.002
        };
        
        const swingLow15m = tf15m?.indicators?.swingLow || ema21_1h * 0.995;
        const stopLoss = swingLow15m;
        const R = Math.abs(entryMid - stopLoss);
        
        const tp1 = entryMid + (R * 1.5);
        const tp2 = entryMid + (R * 3.0);
        
        // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
        const aggressiveEntryZoneScalp = calculateAggressiveEntryZone(currentPrice, 'long');
        chosenStrategy = {
          valid: true,
          direction: 'long',
          confidence: Math.min(100, htfBias.confidence - 10), // Slightly lower for scalp
          reason: `AGGRESSIVE: HTF bias long (${htfBias.confidence}%) + 1H/15m uptrend, scalp entry despite 4H flat`,
          entryType: 'breakout', // AGGRESSIVE forced trades use aggressive entry (close to price)
          override: true,
          notes: ['Override: AGGRESSIVE mode with HTF bias and short-term momentum', `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`, '1H and 15m trends aligned despite 4H flat', 'Aggressive entry: close to current price'],
          entryZone: aggressiveEntryZoneScalp ? {
            min: parseFloat(aggressiveEntryZoneScalp.min.toFixed(2)),
            max: parseFloat(aggressiveEntryZoneScalp.max.toFixed(2))
          } : {
            min: parseFloat((currentPrice * 1.0001).toFixed(2)),
            max: parseFloat((currentPrice * 1.0005).toFixed(2))
          },
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          invalidationLevel: parseFloat(stopLoss.toFixed(2)),
          targets: [parseFloat(tp1.toFixed(2)), parseFloat(tp2.toFixed(2))],
          riskReward: {
            tp1RR: 1.5,
            tp2RR: 3.0
          },
          penaltiesApplied: [],
          capsApplied: [],
          explanation: 'AGGRESSIVE mode: Forced scalp trade when 4H is FLAT but HTF bias + lower TFs align',
          confluence: {
            trendAlignment: `HTF bias: ${htfBias.direction} (${htfBias.confidence}%), 1H: ${trend1hNorm}, 15m: ${trend15mNorm}`,
            stochMomentum: 'AGGRESSIVE forced entry',
            pullbackState: 'N/A',
            liquidityZones: 'N/A',
            htfConfirmation: `${htfBias.confidence}% confidence`
          },
          validationErrors: []
        };
        chosenName = 'SCALP_1H';
      }
      
      // If still not chosen, try MICRO_SCALP - FORCE override
      if (!chosenStrategy && trend5mNorm === 'uptrend') {
        const ema21_5m = tf5m?.indicators?.ema?.ema21 || currentPrice;
        const entryMid = ema21_5m;
        const entryZone = {
          min: entryMid * 0.999,
          max: entryMid * 1.001
        };
        
        const stopLoss = entryMid * 0.998;
        const R = Math.abs(entryMid - stopLoss);
        
        const tp1 = entryMid + (R * 1.0);
        const tp2 = entryMid + (R * 1.5);
        
        // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
        const aggressiveEntryZoneMicro = calculateAggressiveEntryZone(currentPrice, 'long');
        chosenStrategy = {
          valid: true,
          direction: 'long',
          confidence: Math.min(100, htfBias.confidence - 15), // Lower for micro
          reason: `AGGRESSIVE: HTF bias long (${htfBias.confidence}%) + 1H/15m/5m uptrend, micro scalp despite 4H flat`,
          entryType: 'breakout', // AGGRESSIVE forced trades use aggressive entry (close to price)
          override: true,
          notes: ['Override: AGGRESSIVE mode with HTF bias and short-term momentum', `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`, '1H, 15m, and 5m trends aligned despite 4H flat', 'Aggressive entry: close to current price'],
          entryZone: aggressiveEntryZoneMicro ? {
            min: parseFloat(aggressiveEntryZoneMicro.min.toFixed(2)),
            max: parseFloat(aggressiveEntryZoneMicro.max.toFixed(2))
          } : {
            min: parseFloat((currentPrice * 1.0001).toFixed(2)),
            max: parseFloat((currentPrice * 1.0005).toFixed(2))
          },
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          invalidationLevel: parseFloat(stopLoss.toFixed(2)),
          targets: [parseFloat(tp1.toFixed(2)), parseFloat(tp2.toFixed(2))],
          riskReward: {
            tp1RR: 1.0,
            tp2RR: 1.5
          },
          penaltiesApplied: [],
          capsApplied: [],
          explanation: 'AGGRESSIVE mode: Forced micro scalp when 4H is FLAT but HTF bias + lower TFs align',
          confluence: {
            trendAlignment: `HTF bias: ${htfBias.direction} (${htfBias.confidence}%), 1H: ${trend1hNorm}, 15m: ${trend15mNorm}, 5m: ${trend5mNorm}`,
            stochMomentum: 'AGGRESSIVE forced entry',
            pullbackState: 'N/A',
            liquidityZones: 'N/A',
            htfConfirmation: `${htfBias.confidence}% confidence`
          },
          validationErrors: []
        };
        chosenName = 'MICRO_SCALP';
      }
      
      // Apply chosen strategy - FORCE override for longs
      if (chosenStrategy && chosenName) {
        console.log(`[AGGRESSIVE_FORCE] ${symbol}: FORCING ${chosenName} LONG to valid=true, direction=${chosenStrategy.direction}`);
        console.log(`[TEST_CASE_B] ${symbol} AGGRESSIVE_MODE: FORCED ${chosenName} valid=true, reason="${chosenStrategy.reason}"`);
        strategies[chosenName] = chosenStrategy;
      } else {
        console.log(`[AGGRESSIVE_FORCE] ${symbol}: No LONG strategy chosen despite conditions being met!`);
        console.log(`[TEST_CASE_B] ${symbol} AGGRESSIVE_MODE: FAILED - No strategy forced despite conditions`);
      }
    } else {
      console.log(`[AGGRESSIVE_FORCE] ${symbol}: LONG conditions NOT met. HTF=${htfBias.direction}(${htfBias.confidence}%), 1H=${trend1hNorm}, 15m=${trend15mNorm}`);
    }
    
    // REQUIRED SHORT SETUP IN AGGRESSIVE_MODE (lowered threshold to 60% as per requirements)
    if (htfBias.direction === 'short' && htfBias.confidence >= 60 && 
        trend1hNorm === 'downtrend' && trend15mNorm === 'downtrend') {
      
      // Similar logic for shorts
      let chosenStrategy = null;
      let chosenName = null;
      
      // Try TREND_4H first - FORCE override for shorts (always create if conditions met)
      {
        const ema21_1h = tf1h?.indicators?.ema?.ema21 || currentPrice;
        const ema21_15m = tf15m?.indicators?.ema?.ema21 || currentPrice;
        const entryMid = (ema21_1h + ema21_15m) / 2;
        const entryZone = {
          min: entryMid * 0.995,
          max: entryMid * 1.005
        };
        
        const swingHigh1h = tf1h?.indicators?.swingHigh || ema21_1h * 1.02;
        const stopLoss = swingHigh1h;
        const R = Math.abs(stopLoss - entryMid);
        
        const tp1 = entryMid - (R * 1.5);
        const tp2 = entryMid - (R * 3.0);
        
        // AGGRESSIVE mode: ALWAYS use aggressive entry (close to or ahead of price)
        const aggressiveEntryZoneShort = calculateAggressiveEntryZone(currentPrice, 'short');
        chosenStrategy = {
          valid: true,
          direction: 'short',
          confidence: Math.min(100, htfBias.confidence),
          reason: `AGGRESSIVE: HTF bias short (${htfBias.confidence}%) + 1H/15m downtrend aligned, using lower TFs despite 4H flat`,
          entryType: 'breakout', // AGGRESSIVE forced trades use aggressive entry (close to price)
          override: true,
          notes: ['Override: AGGRESSIVE mode with HTF bias and short-term momentum', `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`, '1H and 15m trends aligned despite 4H flat', 'Aggressive entry: close to current price'],
          entryZone: aggressiveEntryZoneShort ? {
            min: parseFloat(aggressiveEntryZoneShort.min.toFixed(2)),
            max: parseFloat(aggressiveEntryZoneShort.max.toFixed(2))
          } : {
            min: parseFloat((currentPrice * 0.9995).toFixed(2)),
            max: parseFloat((currentPrice * 0.9999).toFixed(2))
          },
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          invalidationLevel: parseFloat(stopLoss.toFixed(2)),
          targets: [parseFloat(tp1.toFixed(2)), parseFloat(tp2.toFixed(2))],
          riskReward: {
            tp1RR: 1.5,
            tp2RR: 3.0
          },
          penaltiesApplied: [],
          capsApplied: [],
          explanation: 'AGGRESSIVE mode: Forced trade when 4H is FLAT but HTF bias + lower TFs align',
          confluence: {
            trendAlignment: `HTF bias: ${htfBias.direction} (${htfBias.confidence}%), 1H: ${trend1hNorm}, 15m: ${trend15mNorm}`,
            stochMomentum: 'AGGRESSIVE forced entry',
            pullbackState: 'N/A',
            liquidityZones: 'N/A',
            htfConfirmation: `${htfBias.confidence}% confidence`
          },
          validationErrors: []
        };
        chosenName = 'TREND_4H';
      }
      
      // If TREND_4H not chosen, try SCALP_1H - FORCE override for shorts
      if (!chosenStrategy) {
        const ema21_1h = tf1h?.indicators?.ema?.ema21 || currentPrice;
        const entryMid = ema21_1h;
        const entryZone = {
          min: entryMid * 0.998,
          max: entryMid * 1.002
        };
        
        const swingHigh15m = tf15m?.indicators?.swingHigh || ema21_1h * 1.005;
        const stopLoss = swingHigh15m;
        const R = Math.abs(stopLoss - entryMid);
        
        const tp1 = entryMid - (R * 1.5);
        const tp2 = entryMid - (R * 3.0);
        
        chosenStrategy = {
          valid: true,
          direction: 'short',
          confidence: Math.min(100, htfBias.confidence - 10),
          reason: `AGGRESSIVE: HTF bias short (${htfBias.confidence}%) + 1H/15m downtrend, scalp entry despite 4H flat`,
          entryType: 'pullback', // AGGRESSIVE forced trades use pullback entry
          override: true,
          notes: ['Override: AGGRESSIVE mode with HTF bias and short-term momentum', `HTF bias: ${htfBias.direction} (${htfBias.confidence}%)`, '1H and 15m trends aligned despite 4H flat'],
          entryZone: {
            min: parseFloat(entryZone.min.toFixed(2)),
            max: parseFloat(entryZone.max.toFixed(2))
          },
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          invalidationLevel: parseFloat(stopLoss.toFixed(2)),
          targets: [parseFloat(tp1.toFixed(2)), parseFloat(tp2.toFixed(2))],
          riskReward: {
            tp1RR: 1.5,
            tp2RR: 3.0
          },
          penaltiesApplied: [],
          capsApplied: [],
          explanation: 'AGGRESSIVE mode: Forced scalp trade when 4H is FLAT but HTF bias + lower TFs align',
          confluence: {
            trendAlignment: `HTF bias: ${htfBias.direction} (${htfBias.confidence}%), 1H: ${trend1hNorm}, 15m: ${trend15mNorm}`,
            stochMomentum: 'AGGRESSIVE forced entry',
            pullbackState: 'N/A',
            liquidityZones: 'N/A',
            htfConfirmation: `${htfBias.confidence}% confidence`
          },
          validationErrors: []
        };
        chosenName = 'SCALP_1H';
      }
      
      // If still not chosen, try MICRO_SCALP - FORCE override for shorts
      if (!chosenStrategy && trend5mNorm === 'downtrend') {
        const ema21_5m = tf5m?.indicators?.ema?.ema21 || currentPrice;
        const entryMid = ema21_5m;
        const entryZone = {
          min: entryMid * 0.999,
          max: entryMid * 1.001
        };
        
        const stopLoss = entryMid * 1.002;
        const R = Math.abs(stopLoss - entryMid);
        
        const tp1 = entryMid - (R * 1.0);
        const tp2 = entryMid - (R * 1.5);
        
        chosenStrategy = {
          valid: true,
          direction: 'short',
          confidence: Math.min(100, htfBias.confidence - 15),
          reason: `AGGRESSIVE: HTF bias short (${htfBias.confidence}%) + 1H/15m/5m downtrend, micro scalp despite 4H flat`,
          entryZone: {
            min: parseFloat(entryZone.min.toFixed(2)),
            max: parseFloat(entryZone.max.toFixed(2))
          },
          stopLoss: parseFloat(stopLoss.toFixed(2)),
          invalidationLevel: parseFloat(stopLoss.toFixed(2)),
          targets: [parseFloat(tp1.toFixed(2)), parseFloat(tp2.toFixed(2))],
          riskReward: {
            tp1RR: 1.0,
            tp2RR: 1.5
          },
          validationErrors: []
        };
        chosenName = 'MICRO_SCALP';
      }
      
      // Apply chosen strategy - FORCE override for shorts
      if (chosenStrategy && chosenName) {
        console.log(`[AGGRESSIVE_FORCE] ${symbol}: FORCING ${chosenName} SHORT to valid=true`);
        console.log(`[TEST_CASE_B] ${symbol} AGGRESSIVE_MODE: FORCED ${chosenName} valid=true, reason="${chosenStrategy.reason}"`);
        strategies[chosenName] = chosenStrategy;
      }
    } else {
      console.log(`[AGGRESSIVE_FORCE] ${symbol}: SHORT conditions NOT met. HTF=${htfBias.direction}(${htfBias.confidence}%), 1H=${trend1hNorm}, 15m=${trend15mNorm}`);
    }
    } // Close the else block for htfBias check
  } else if (mode === 'AGGRESSIVE' && !is4HFlat) {
    console.log(`[AGGRESSIVE_FORCE] ${symbol}: 4H is NOT flat, forcing logic skipped`);
  }
  
  // Recalculate valid strategies after AGGRESSIVE forcing (if any were forced)
  const validStrategies = Object.entries(strategies)
    .filter(([_, s]) => s && s.valid === true)
    .map(([name, s]) => ({ name, confidence: s.confidence, strategy: s }));
  
  let bestSignal = null;
  
  if (validStrategies.length > 0) {
    if (mode === 'STANDARD') {
      // SAFE_MODE priority: TREND_4H → TREND_RIDER → SWING → SCALP_1H → MICRO_SCALP
      const priority = ['TREND_4H', 'TREND_RIDER', 'SWING', 'SCALP_1H', 'MICRO_SCALP'];
      for (const priorityName of priority) {
        const found = validStrategies.find(s => s.name === priorityName);
        if (found) {
          bestSignal = found.name;
          break;
        }
      }
      // Fallback to highest confidence if priority doesn't match
      if (!bestSignal) {
        bestSignal = validStrategies.sort((a, b) => b.confidence - a.confidence)[0].name;
      }
    } else {
      // AGGRESSIVE_MODE priority: TREND_RIDER → TREND_4H → SCALP_1H → MICRO_SCALP → SWING
      const priority = ['TREND_RIDER', 'TREND_4H', 'SCALP_1H', 'MICRO_SCALP', 'SWING'];
      for (const priorityName of priority) {
        const found = validStrategies.find(s => s.name === priorityName);
        if (found) {
          bestSignal = found.name;
          break;
        }
      }
      // Fallback to highest confidence if priority doesn't match
      if (!bestSignal) {
        bestSignal = validStrategies.sort((a, b) => b.confidence - a.confidence)[0].name;
      }
    }
  }
  
  // DEBUG: Log strategies keys to verify TREND_RIDER is included
  console.log('DEBUG strategies keys', {
    symbol,
    mode,
    keys: Object.keys(strategies),
    hasTREND_RIDER: 'TREND_RIDER' in strategies,
    TREND_RIDER_valid: strategies.TREND_RIDER?.valid,
    TREND_RIDER_reason: strategies.TREND_RIDER?.reason
  });
  
  console.log(`[evaluateAllStrategies] ${symbol} mode=${mode} bestSignal=${bestSignal}, validStrategies=${validStrategies.length}`);
  console.log(`[TEST_CASE_${mode === 'STANDARD' ? 'A' : 'B'}] ${symbol} ${mode}: bestSignal=${bestSignal}, strategies valid: ${Object.entries(strategies).filter(([_, s]) => s && s.valid).map(([name]) => name).join(', ')}`);
  console.log(`[evaluateAllStrategies] === SUCCESS === ${symbol}`);
  
  return {
    strategies,
    bestSignal
  };
  
  } catch (error) {
    console.error(`[evaluateAllStrategies] === ERROR === ${symbol}`);
    console.error(`[evaluateAllStrategies] Error name:`, error.name);
    console.error(`[evaluateAllStrategies] Error message:`, error.message);
    console.error(`[evaluateAllStrategies] Error stack:`, error.stack);
    console.error(`[evaluateAllStrategies] Full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
    throw error; // Re-throw to be caught by API handler
  }
}

/**
 * Normalize a strategy result to the canonical strategy format
 * ALWAYS returns a strategy object, even if NO_TRADE
 * @param {Object} result - Strategy evaluation result
 * @param {string} strategyName - Name of the strategy
 * @param {string} mode - STANDARD or AGGRESSIVE
 */
function normalizeStrategyResult(result, strategyName, mode = 'STANDARD', overrideUsed = false, overrideNotes = []) {
  if (!result) {
    return createNoTradeStrategy(strategyName, 'Strategy evaluation failed - no signal returned');
  }
  
  // Handle both wrapped ({ signal: {...} }) and unwrapped (signal directly) formats
  const signal = result.signal || result;
  
  if (!signal || (typeof signal !== 'object')) {
    return createNoTradeStrategy(strategyName, 'Strategy evaluation failed - invalid signal format');
  }
  
  // If valid=false, ensure all fields are null/empty
  // IMPORTANT: In AGGRESSIVE_MODE, never use SAFE_MODE blocking reasons
  if (!signal.valid) {
    let reason = signal.reason || signal.reason_summary || 'No trade setup available';
    
    // AGGRESSIVE_MODE override: Replace ANY SAFE_MODE blocking reasons
    // Check for any variation of the blocking reason
    if (mode === 'AGGRESSIVE') {
      if (reason.includes('4H trend is FLAT') && reason.includes('no trade allowed')) {
        reason = 'AGGRESSIVE_MODE: Evaluating lower timeframe confluence despite 4H flat';
      }
      if (reason.includes('4H trend is FLAT - no trade allowed per strategy rules')) {
        reason = 'AGGRESSIVE_MODE: Evaluating lower timeframe confluence despite 4H flat';
      }
      if (reason.includes('4H trend is FLAT - no trade allowed per SAFE_MODE rules')) {
        reason = 'AGGRESSIVE_MODE: Evaluating lower timeframe confluence despite 4H flat';
      }
      if (reason.includes('Setup requirements not met') && reason.includes('4H')) {
        reason = 'AGGRESSIVE_MODE: Evaluating lower timeframe confluence despite 4H flat';
      }
    }
    
    return {
      valid: false,
      direction: 'NO_TRADE',
      confidence: 0,
      reason: reason,
      entryZone: { min: null, max: null },
      stopLoss: null,
      invalidationLevel: null,
      targets: [],
      riskReward: { tp1RR: null, tp2RR: null },
      validationErrors: []
    };
  }
  
  // If valid=true, ensure all required fields are present
  const normalized = {
    valid: true,
    direction: signal.direction || 'NO_TRADE',
    confidence: typeof signal.confidence === 'number' 
      ? Math.round(signal.confidence > 1 ? signal.confidence : signal.confidence * 100)
      : 0,
    reason: signal.reason || 'Trade setup available',
    entryZone: signal.entryZone || { min: null, max: null },
    stopLoss: signal.stopLoss || null,
    invalidationLevel: signal.invalidationLevel || null,
    targets: Array.isArray(signal.targets) 
      ? signal.targets.filter(t => t !== null && t !== undefined && !isNaN(t))
      : [],
    riskReward: signal.riskReward || { tp1RR: null, tp2RR: null },
    validationErrors: [],
    // NEW FIELDS (optional, backward compatible)
    penaltiesApplied: signal.penaltiesApplied || [],
    capsApplied: signal.capsApplied || [],
    explanation: signal.explanation || null,
    override: signal.override || overrideUsed || false, // Mark if override was used
    notes: signal.notes || (overrideUsed && overrideNotes.length > 0 ? overrideNotes : overrideUsed ? ['SAFE override activated'] : []) // Add override notes if used
  };
  
  return normalized;
}

/**
 * Normalize MicroScalp result
 */
function normalizeMicroScalpResult(microScalpSignal, symbol) {
  if (!microScalpSignal || !microScalpSignal.valid) {
    return createNoTradeStrategy('MICRO_SCALP', 'MicroScalp conditions not met');
  }
  
  return {
    valid: true,
    direction: microScalpSignal.direction || 'NO_TRADE',
    confidence: typeof microScalpSignal.confidence === 'number'
      ? (microScalpSignal.confidence > 1 ? microScalpSignal.confidence : microScalpSignal.confidence * 100)
      : 0,
    reason: microScalpSignal.reason || 'MicroScalp setup detected',
    entryZone: microScalpSignal.entry || { min: null, max: null },
    stopLoss: microScalpSignal.stopLoss || null,
    invalidationLevel: microScalpSignal.invalidation_level || null,
    targets: microScalpSignal.targets 
      ? (Array.isArray(microScalpSignal.targets) 
          ? microScalpSignal.targets 
          : [microScalpSignal.targets.tp1, microScalpSignal.targets.tp2].filter(t => t !== null))
      : [],
    riskReward: microScalpSignal.riskReward || { tp1RR: null, tp2RR: null },
    validationErrors: []
  };
}

/**
 * Create a NO_TRADE strategy object
 */
function createNoTradeStrategy(strategyName, reason) {
  return {
    valid: false,
    direction: 'NO_TRADE',
    confidence: 0,
    reason: reason || 'No trade setup available',
    entryZone: { min: null, max: null },
    stopLoss: null,
    invalidationLevel: null,
    targets: [],
    riskReward: { tp1RR: null, tp2RR: null },
    validationErrors: []
  };
}

/**
 * Build rich timeframe summary from multiTimeframeData
 */
export function buildTimeframeSummary(multiTimeframeData) {
  const timeframes = {};
  
  for (const [tf, data] of Object.entries(multiTimeframeData)) {
    if (!data || data.error || !data.indicators) continue;
    
    const indicators = data.indicators;
    const stoch = indicators.stochRSI || {};
    
    // Clamp Stoch RSI k and d to [0, 100] to prevent floating-point noise
    const stochK = stoch.k != null ? Math.min(100, Math.max(0, stoch.k)) : null;
    const stochD = stoch.d != null ? Math.min(100, Math.max(0, stoch.d)) : null;
    
    // Determine stoch state
    let stochState = 'neutral';
    if (stochK != null && stochD != null) {
      if (stochK > 80 && stochD > 80) stochState = 'overbought';
      else if (stochK < 20 && stochD < 20) stochState = 'oversold';
    }
    
    // Normalize trend enum: "up" | "down" | "flat" (consistent across all outputs)
    let trend = (indicators.analysis?.trend || 'UNKNOWN').toLowerCase();
    if (trend.includes('uptrend') || trend === 'up') trend = 'up';
    else if (trend.includes('downtrend') || trend === 'down') trend = 'down';
    else if (trend === 'flat') trend = 'flat';
    else trend = 'flat'; // Default to flat for unknown
    
    timeframes[tf] = {
      trend: trend, // Normalized: "up" | "down" | "flat"
      ema21: indicators.ema?.ema21 || null,
      ema200: indicators.ema?.ema200 || null,
      stochRsi: {
        k: stochK, // Clamped to [0, 100]
        d: stochD, // Clamped to [0, 100]
        state: stochState
      },
      confluenceScore: indicators.confluence?.overall || null,
      structureSummary: buildStructureSummary(data.structure, indicators),
      notes: buildTimeframeNotes(tf, indicators, data.structure)
    };
  }
  
  return timeframes;
}

/**
 * Build structure summary text
 */
function buildStructureSummary(structure, indicators) {
  if (!structure) return '';
  
  const { swingHigh, swingLow } = structure;
  const price = indicators.price?.current;
  const trend = indicators.analysis?.trend;
  
  if (!price) return '';
  
  if (trend === 'UPTREND') {
    return `Higher highs, higher lows above 21 EMA`;
  } else if (trend === 'DOWNTREND') {
    return `Lower highs, lower lows below 21 EMA`;
  } else {
    return `Choppy structure, price consolidating`;
  }
}

/**
 * Build timeframe notes
 */
function buildTimeframeNotes(tf, indicators, structure) {
  const notes = [];
  const trend = indicators.analysis?.trend;
  const pullbackState = indicators.analysis?.pullbackState;
  const distance = indicators.analysis?.distanceFrom21EMA;
  
  if (trend && trend !== 'FLAT') {
    notes.push(`${tf.toUpperCase()} trend: ${trend}`);
  }
  
  if (pullbackState) {
    notes.push(`Pullback: ${pullbackState}`);
  }
  
  if (distance !== undefined && distance !== null) {
    notes.push(`${Math.abs(distance).toFixed(2)}% from 21 EMA`);
  }
  
  return notes.join('; ');
}

export default {
  evaluateStrategy,
  evaluateAllStrategies,
  buildTimeframeSummary,
  analyzeStochState,
  evaluateMicroScalp,
  evaluateSwingSetup,
  evaluateTrendRider,
  computeHTFBias,
  calculateConfidenceWithHierarchy,
  calculateBreakoutEntryZone,
  calculateAggressiveEntryZone,
  isBreakoutConfirmed,
  checkDflowAlignment
};


