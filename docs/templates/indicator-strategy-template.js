/**
 * TEMPLATE: Using Indicators in Strategy Evaluation
 * 
 * This template shows how to access and use indicators in strategy logic.
 * File: services/strategy.js
 * 
 * Replace "EMA50" with your indicator name and adapt the logic.
 */

// ============================================================================
// PATTERN 1: Accessing Indicators in Strategy Evaluation
// ============================================================================

export function evaluateStrategy(symbol, multiTimeframeData, setupType = '4h', mode = 'STANDARD') {
  // Get timeframe data
  const tf4h = multiTimeframeData['4h'];
  const tf1h = multiTimeframeData['1h'];
  
  if (!tf4h || !tf1h) {
    return createNoTradeStrategy('TREND_4H', 'Missing required timeframe data');
  }
  
  // ==========================================================================
  // Access your indicator here
  // ==========================================================================
  
  const ema21 = tf4h.indicators.ema.ema21;
  const ema200 = tf4h.indicators.ema.ema200;
  const ema50 = tf4h.indicators.ema.ema50;  // ADD YOUR INDICATOR
  
  // Always check for null values
  if (!ema50) {
    // Handle case where indicator not available
    // Either skip logic or use fallback
  }
  
  // ==========================================================================
  // Use indicator in trend detection
  // ==========================================================================
  
  const currentPrice = tf4h.indicators.price.current;
  const trend4h = normalizeTrend(tf4h.indicators.analysis.trend);
  
  // Example: Enhanced trend detection with EMA50
  let enhancedTrend = trend4h;
  if (ema50 && ema21 && ema200) {
    // Strong uptrend: price > EMA21 > EMA50 > EMA200
    if (currentPrice > ema21 && ema21 > ema50 && ema50 > ema200) {
      enhancedTrend = 'uptrend';
    }
    // Strong downtrend: price < EMA21 < EMA50 < EMA200
    else if (currentPrice < ema21 && ema21 < ema50 && ema50 < ema200) {
      enhancedTrend = 'downtrend';
    }
  }
  
  // ==========================================================================
  // Use indicator in entry logic
  // ==========================================================================
  
  // Example: Entry zone near EMA50
  const entryZone = calculateEntryZone(ema21, direction);
  
  // Adjust entry zone based on EMA50
  if (ema50 && direction === 'long') {
    // If price is above EMA50, use EMA50 as support
    if (currentPrice > ema50) {
      entryZone.min = Math.min(entryZone.min, ema50 * 0.999);  // Slightly below EMA50
    }
  }
  
  // ==========================================================================
  // Use indicator in confidence scoring
  // ==========================================================================
  
  function calculateConfidence(analysis, direction) {
    let score = 0;
    const tf4h = analysis['4h'];
    
    // Base confidence from trend alignment
    const trend4h = normalizeTrend(tf4h.indicators.analysis.trend);
    if (direction === 'long' && trend4h === 'uptrend') score += 0.4;
    
    // ADD YOUR INDICATOR LOGIC HERE
    const ema50 = tf4h.indicators.ema.ema50;
    if (ema50) {
      const currentPrice = tf4h.indicators.price.current;
      
      // Bonus for price above EMA50 in long trades
      if (direction === 'long' && currentPrice > ema50) {
        score += 0.05;  // Small bonus
      }
      // Penalty for price below EMA50 in long trades
      else if (direction === 'long' && currentPrice < ema50) {
        score -= 0.05;  // Small penalty
      }
      // Similar logic for short trades
      else if (direction === 'short' && currentPrice < ema50) {
        score += 0.05;
      }
      else if (direction === 'short' && currentPrice > ema50) {
        score -= 0.05;
      }
    }
    
    return Math.min(Math.max(score, 0), 1.0);  // Clamp to [0, 1]
  }
  
  // ==========================================================================
  // Use indicator in hierarchical confidence calculation
  // ==========================================================================
  
  function calculateConfidenceWithHierarchy(multiTimeframeData, direction, mode = 'STANDARD') {
    // ... existing macro/primary/execution layer logic ...
    
    // ADD YOUR INDICATOR TO RELEVANT LAYERS
    const tf4h = multiTimeframeData['4h'];
    const ema50 = tf4h?.indicators?.ema?.ema50;
    
    if (ema50) {
      const currentPrice = tf4h.indicators.price.current;
      
      // Add to primary trend layer (4H, 1H)
      if (direction === 'long' && currentPrice > ema50) {
        // Bonus for alignment
        baseConfidence += 2;  // Small boost
      } else if (direction === 'short' && currentPrice < ema50) {
        baseConfidence += 2;
      } else {
        // Contradiction penalty
        penaltiesApplied.push({
          layer: 'primary',
          reason: 'Price contradicts EMA50 alignment',
          multiplier: 0.95
        });
        baseConfidence *= 0.95;
      }
    }
    
    // ... rest of confidence calculation ...
  }
  
  // ==========================================================================
  // Use indicator in signal validation
  // ==========================================================================
  
  // Example: Validate signal based on EMA50
  function validateSignal(signal, analysis) {
    const tf4h = analysis['4h'];
    const ema50 = tf4h.indicators.ema.ema50;
    const currentPrice = tf4h.indicators.price.current;
    
    if (!ema50) {
      return true;  // Skip validation if indicator not available
    }
    
    // Long trades: price should be above EMA50
    if (signal.direction === 'long' && currentPrice < ema50) {
      return {
        valid: false,
        reason: 'Price below EMA50 - invalid for long trade'
      };
    }
    
    // Short trades: price should be below EMA50
    if (signal.direction === 'short' && currentPrice > ema50) {
      return {
        valid: false,
        reason: 'Price above EMA50 - invalid for short trade'
      };
    }
    
    return { valid: true };
  }
}

// ============================================================================
// PATTERN 2: Multi-Timeframe Indicator Usage
// ============================================================================

function evaluateMultiTimeframeSignal(analysis, direction) {
  // Check indicator across multiple timeframes
  const tf4h = analysis['4h'];
  const tf1h = analysis['1h'];
  
  const ema50_4h = tf4h.indicators.ema.ema50;
  const ema50_1h = tf1h.indicators.ema.ema50;
  
  // Count alignments
  let alignments = 0;
  if (ema50_4h && direction === 'long' && tf4h.indicators.price.current > ema50_4h) {
    alignments++;
  }
  if (ema50_1h && direction === 'long' && tf1h.indicators.price.current > ema50_1h) {
    alignments++;
  }
  
  // Higher confidence with more alignments
  return alignments;
}

// ============================================================================
// NOTES:
// ============================================================================
//
// 1. Always check for null values before using indicators
// 2. Use normalizeTrend() for trend comparisons
// 3. Access indicators via: analysis[tf].indicators.yourIndicator
// 4. Consider multi-timeframe alignment for higher confidence
// 5. Document any new strategy rules that use the indicator
//
// ============================================================================
// COMMON PATTERNS:
// ============================================================================
//
// Pattern A: Trend Confirmation
//   if (indicator > threshold && direction === 'long') { bonus }
//
// Pattern B: Entry Timing
//   if (price near indicator && direction === 'long') { entry }
//
// Pattern C: Risk Management
//   if (price breaks indicator) { invalidate trade }
//
// Pattern D: Confidence Scoring
//   if (indicator aligns) { increase confidence }
//   if (indicator contradicts) { decrease confidence }
//
// ============================================================================

