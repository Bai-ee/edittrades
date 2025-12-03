/**
 * TEMPLATE: Adding a New Indicator - Calculation Layer
 * 
 * This template shows how to add a 50 EMA indicator as a complete example.
 * Replace "EMA50" with your indicator name and adapt the logic.
 * 
 * File: services/indicators.js
 */

// ============================================================================
// STEP 1: Create the calculation function
// ============================================================================

/**
 * Calculate 50 EMA from price data
 * @param {Array<number>} prices - Array of close prices
 * @returns {Array<number>} EMA values
 */
export function calculateEMA50(prices) {
  // Validate minimum data requirements
  if (prices.length < 50) {
    throw new Error('Not enough data points for 50 EMA (need at least 50)');
  }

  // Use technicalindicators library
  return EMA.calculate({
    period: 50,
    values: prices
  });
}

// ============================================================================
// STEP 2: Integrate into calculateAllIndicators()
// ============================================================================

export function calculateAllIndicators(candles) {
  if (!candles || candles.length === 0) {
    throw new Error('No candle data provided');
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // ==========================================================================
  // ADD YOUR INDICATOR CALCULATION HERE (with error handling)
  // ==========================================================================
  
  // Calculate EMAs
  let ema21, ema200, ema50;  // ADD your indicator variable
  try {
    ema21 = calculateEMA21(closes);
  } catch (error) {
    ema21 = null;
  }

  try {
    ema200 = calculateEMA200(closes);
  } catch (error) {
    ema200 = null;
  }

  // ADD THIS BLOCK for your indicator
  let ema50;
  try {
    ema50 = calculateEMA50(closes);
  } catch (error) {
    ema50 = null;  // Gracefully handle insufficient data
  }

  // ==========================================================================
  // STEP 3: Extract current values
  // ==========================================================================
  
  const currentPrice = closes[closes.length - 1];
  const currentEMA21 = ema21 ? ema21[ema21.length - 1] : null;
  const currentEMA200 = ema200 ? ema200[ema200.length - 1] : null;
  const currentEMA50 = ema50 ? ema50[ema50.length - 1] : null;  // ADD THIS

  // ==========================================================================
  // STEP 4: Add to return object structure
  // ==========================================================================
  
  return {
    price: {
      current: currentPrice,
      high: Math.max(...highs),
      low: Math.min(...lows)
    },
    ema: {
      ema21: currentEMA21,
      ema200: currentEMA200,
      ema50: currentEMA50,              // ADD current value
      ema21History: ema21,
      ema200History: ema200,
      ema50History: ema50,              // ADD history (if applicable)
    },
    stochRSI: {
      // ... existing stochRSI structure
    },
    analysis: {
      // ... existing analysis structure
    },
    metadata: {
      candleCount: candles.length,
      lastUpdate: new Date(candles[candles.length - 1].timestamp).toISOString()
    }
  };
}

// ============================================================================
// STEP 5: Export function (if using named exports)
// ============================================================================

export default {
  calculateEMA21,
  calculateEMA200,
  calculateEMA50,  // ADD your function here
  calculateStochasticRSI,
  calculateAllIndicators,
  detectSwingPoints,
  detectWickRejection
};

// ============================================================================
// NOTES:
// ============================================================================
// 
// 1. Always wrap calculation in try/catch to handle insufficient data
// 2. Return null if calculation fails (don't throw errors)
// 3. Include both current value and history (if applicable)
// 4. Follow existing naming conventions
// 5. Add JSDoc comments for documentation
// 
// ============================================================================
// ALTERNATIVE: Derived Indicator (from existing indicators)
// ============================================================================
//
// If your indicator is derived from existing indicators:
//
// let ema50Position = null;
// if (currentEMA50 && currentPrice) {
//   ema50Position = currentPrice > currentEMA50 ? 'ABOVE' : 'BELOW';
// }
//
// return {
//   // ... existing structure
//   analysis: {
//     trend,
//     pullbackState,
//     distanceFrom21EMA,
//     ema50Position  // ADD derived indicator
//   }
// };
//
// ============================================================================

