/**
 * REFACTORED Multi-Timeframe Trading Strategy Engine
 * 
 * KEY CHANGES:
 * 1. All invariants enforced at creation time (no post-processing)
 * 2. Confidence is 0-100 scale consistently
 * 3. valid=true ONLY when all required fields are present
 * 4. SAFE_MODE and AGGRESSIVE_MODE use shared base logic with different thresholds
 * 5. No half-valid signals - either fully valid or invalid
 */

import * as indicators from './indicators.js';

/**
 * INVARIANT VALIDATION FUNCTIONS
 * These enforce consistency at creation time
 */

/**
 * Validate a strategy signal meets all invariants
 * Throws error if invalid (for development) or returns false (for production)
 */
function validateStrategySignal(signal) {
  if (!signal) return false;
  
  // If valid=true, ALL required fields must be present
  if (signal.valid === true) {
    // Check entry zone
    if (!signal.entryZone || 
        signal.entryZone.min === null || 
        signal.entryZone.max === null ||
        signal.entryZone.min > signal.entryZone.max) {
      console.error('❌ Invalid signal: valid=true but entryZone invalid', signal);
      return false;
    }
    
    // Check stop loss
    if (signal.stopLoss === null || signal.stopLoss === undefined) {
      console.error('❌ Invalid signal: valid=true but stopLoss is null', signal);
      return false;
    }
    
    // Check invalidation level
    if (signal.invalidationLevel === null || signal.invalidationLevel === undefined) {
      console.error('❌ Invalid signal: valid=true but invalidationLevel is null', signal);
      return false;
    }
    
    // Check at least one target
    if (!signal.targets || signal.targets.length === 0 || signal.targets[0] === null) {
      console.error('❌ Invalid signal: valid=true but no targets', signal);
      return false;
    }
    
    // Check direction is not NO_TRADE
    if (signal.direction === 'NO_TRADE' || signal.direction === 'flat') {
      console.error('❌ Invalid signal: valid=true but direction is NO_TRADE', signal);
      return false;
    }
    
    // Check confidence is reasonable (0-100)
    if (signal.confidence < 0 || signal.confidence > 100) {
      console.error('❌ Invalid signal: confidence out of range', signal);
      return false;
    }
    
    // Check stop loss logic
    if (signal.direction === 'long' && signal.stopLoss >= signal.entryZone.min) {
      console.error('❌ Invalid signal: long trade stopLoss >= entryZone.min', signal);
      return false;
    }
    if (signal.direction === 'short' && signal.stopLoss <= signal.entryZone.max) {
      console.error('❌ Invalid signal: short trade stopLoss <= entryZone.max', signal);
      return false;
    }
  } else {
    // If valid=false, should have NO_TRADE direction and 0 confidence
    if (signal.direction !== 'NO_TRADE' && signal.direction !== 'flat') {
      console.warn('⚠️ Signal valid=false but direction is not NO_TRADE', signal);
    }
    if (signal.confidence !== 0) {
      console.warn('⚠️ Signal valid=false but confidence is not 0', signal);
    }
  }
  
  return true;
}

/**
 * Create a NO_TRADE signal with all required fields
 */
function createNoTradeSignal(symbol, reason, strategiesChecked = [], mode = 'STANDARD') {
  return {
    symbol,
    valid: false,
    direction: 'NO_TRADE',
    setupType: 'auto',
    selectedStrategy: 'NO_TRADE',
    strategiesChecked,
    confidence: 0,
    reason: reason || 'No trade setup available',
    entryZone: { min: null, max: null },
    stopLoss: null,
    invalidationLevel: null,
    targets: [null, null],
    riskReward: { tp1RR: null, tp2RR: null },
    riskAmount: null,
    invalidation: {
      level: null,
      description: 'No clear invalidation – awaiting setup formation'
    },
    mode,
    timestamp: new Date().toISOString()
  };
}

/**
 * Normalize confidence to 0-100 scale
 * Input can be 0-1 (decimal) or 0-100 (percentage)
 */
function normalizeConfidence(confidence) {
  if (confidence === null || confidence === undefined) return 0;
  if (confidence > 1) return Math.min(100, Math.max(0, confidence)); // Already 0-100
  return Math.min(100, Math.max(0, confidence * 100)); // Convert 0-1 to 0-100
}

/**
 * Calculate entry zone with validation
 * Returns null if cannot be calculated
 */
function calculateEntryZoneSafe(ema21, direction, maxDistance = 1.0) {
  if (!ema21 || ema21 <= 0) return null;
  if (direction !== 'long' && direction !== 'short') return null;
  
  const buffer = maxDistance / 100; // Convert % to decimal
  
  if (direction === 'long') {
    return {
      min: parseFloat((ema21 * (1 - buffer)).toFixed(2)),
      max: parseFloat((ema21 * (1 + buffer * 0.5)).toFixed(2))
    };
  } else {
    return {
      min: parseFloat((ema21 * (1 - buffer * 0.5)).toFixed(2)),
      max: parseFloat((ema21 * (1 + buffer)).toFixed(2))
    };
  }
}

/**
 * Calculate stop loss and targets with validation
 * Returns null if cannot be calculated
 */
function calculateSLTPSafe(entryMid, direction, structure, setupType, rrTargets) {
  if (!entryMid || entryMid <= 0) return null;
  if (direction !== 'long' && direction !== 'short') return null;
  if (!rrTargets || rrTargets.length < 2) return null;
  
  const buffer = 0.003; // 0.3% buffer
  let stopLoss, invalidationLevel;
  
  // Select appropriate structure level based on setup type
  if (setupType === 'Swing') {
    invalidationLevel = structure.swingLow || structure.swingHigh || null;
  } else if (setupType === 'Scalp' || setupType === 'AGGRO_SCALP_1H') {
    invalidationLevel = structure.swingLow || structure.swingHigh || null;
  } else {
    invalidationLevel = structure.swingLow || structure.swingHigh || null;
  }
  
  if (direction === 'long') {
    stopLoss = invalidationLevel 
      ? parseFloat((invalidationLevel * (1 - buffer)).toFixed(2))
      : parseFloat((entryMid * 0.97).toFixed(2));
    invalidationLevel = invalidationLevel || stopLoss;
    
    const risk = entryMid - stopLoss;
    if (risk <= 0) return null; // Invalid risk
    
    const tp1 = parseFloat((entryMid + (risk * rrTargets[0])).toFixed(2));
    const tp2 = parseFloat((entryMid + (risk * rrTargets[1])).toFixed(2));
    
    return {
      stopLoss,
      invalidationLevel: parseFloat(invalidationLevel.toFixed(2)),
      targets: [tp1, tp2],
      riskAmount: parseFloat(risk.toFixed(2)),
      tp1RR: rrTargets[0],
      tp2RR: rrTargets[1]
    };
  } else {
    stopLoss = invalidationLevel 
      ? parseFloat((invalidationLevel * (1 + buffer)).toFixed(2))
      : parseFloat((entryMid * 1.03).toFixed(2));
    invalidationLevel = invalidationLevel || stopLoss;
    
    const risk = stopLoss - entryMid;
    if (risk <= 0) return null; // Invalid risk
    
    const tp1 = parseFloat((entryMid - (risk * rrTargets[0])).toFixed(2));
    const tp2 = parseFloat((entryMid - (risk * rrTargets[1])).toFixed(2));
    
    return {
      stopLoss,
      invalidationLevel: parseFloat(invalidationLevel.toFixed(2)),
      targets: [tp1, tp2],
      riskAmount: parseFloat(risk.toFixed(2)),
      tp1RR: rrTargets[0],
      tp2RR: rrTargets[1]
    };
  }
}

/**
 * Trading Mode Thresholds
 * STANDARD: Conservative, high-probability setups
 * AGGRESSIVE: Looser requirements for more trade opportunities
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
    min15mStochAlign: true,     // Require 15m stoch strict alignment
    minConfidence: 60           // Minimum confidence for valid signal
  },
  AGGRESSIVE: {
    emaPullbackMax: 1.75,       // Looser pullback zone
    emaPullbackMax1H: 2.5,      // Much looser 1H pullback
    microScalpEmaBand: 0.75,    // ±0.75% band for micro-scalps
    allowFlat4HForScalp: true,  // Allow 4H FLAT for scalps
    allowFlat1HForScalp: true,  // Allow 1H FLAT for scalps
    allowFlat4HForSwing: false, // Still require 4H trend for swings
    minHtfBiasConfidence: 40,   // Lower HTF bias requirement
    maxSwingEmaDist1D: 4.0,     // Looser swing EMA distance
    min15mStochAlign: false,    // Looser stoch alignment
    minConfidence: 40           // Lower minimum confidence
  }
};

// Continue with rest of strategy logic...
// [This is a partial implementation - the full file would continue with all strategy builders]

