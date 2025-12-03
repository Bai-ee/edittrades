/**
 * TEMPLATE: Adding Indicators to JSON Exports
 * 
 * This template shows all locations where indicators need to be added
 * for JSON export functionality.
 * 
 * File: public/index.html
 * 
 * Replace "EMA50" with your indicator name.
 */

// ============================================================================
// LOCATION 1: buildRichSymbolFromScanResults()
// ============================================================================
// Function: buildRichSymbolFromScanResults(symbol, mode)
// Location: ~line 4023
// Purpose: Builds rich symbol object for JSON export

function buildRichSymbolFromScanResults(symbol, mode) {
  // ... existing code ...
  
  // Build timeframes summary
  const timeframes = {};
  if (data.analysis) {
    for (const [tf, tfData] of Object.entries(data.analysis)) {
      if (tfData && tfData.indicators) {
        const stoch = tfData.indicators.stochRSI || {};
        let stochState = 'neutral';
        if (stoch.k > 80 && stoch.d > 80) stochState = 'overbought';
        else if (stoch.k < 20 && stoch.d < 20) stochState = 'oversold';
        
        // ADD YOUR INDICATOR HERE
        timeframes[tf] = {
          trend: (tfData.indicators.analysis?.trend || 'UNKNOWN').toLowerCase(),
          ema21: tfData.indicators.ema?.ema21 || null,
          ema200: tfData.indicators.ema?.ema200 || null,
          ema50: tfData.indicators.ema?.ema50 || null,  // ADD THIS LINE
          stochRsi: {
            k: stoch.k || null,
            d: stoch.d || null,
            state: stochState
          },
          confluenceScore: null,
          structureSummary: '',
          notes: ''
        };
      }
    }
  }
  
  return {
    symbol,
    mode: mode === 'STANDARD' ? 'SAFE' : 'AGGRESSIVE',
    currentPrice: data.currentPrice || null,
    htfBias: { /* ... */ },
    timeframes,  // Includes your indicator
    strategies: { /* ... */ },
    bestSignal: null,
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString()
  };
}

// ============================================================================
// LOCATION 2: Other Export Functions (if they exist)
// ============================================================================
// Search for other functions that build JSON structures
// Common patterns: "timeframes", "indicators", "export", "copy"

// Example: If there's a function that builds a simplified view
function buildSimplifiedView(data) {
  return {
    symbol: data.symbol,
    timeframes: Object.entries(data.analysis).reduce((acc, [tf, tfData]) => {
      if (tfData && tfData.indicators) {
        acc[tf] = {
          trend: tfData.indicators.analysis?.trend,
          ema21: tfData.indicators.ema?.ema21,
          ema200: tfData.indicators.ema?.ema200,
          ema50: tfData.indicators.ema?.ema50,  // ADD HERE TOO
        };
      }
      return acc;
    }, {})
  };
}

// ============================================================================
// LOCATION 3: Copy Button Export Functions
// ============================================================================
// Functions: copyCoinView(), copyAllCoins()
// These use buildRichSymbolFromScanResults(), so they're automatically
// included if you update that function. But verify they work correctly.

// ============================================================================
// JSON STRUCTURE CONSISTENCY
// ============================================================================

/**
 * Your indicator should appear in the JSON structure like this:
 * 
 * {
 *   "symbol": "BTCUSDT",
 *   "timeframes": {
 *     "4h": {
 *       "trend": "uptrend",
 *       "ema21": 94250.45,
 *       "ema200": 92000.00,
 *       "ema50": 93500.00,  // YOUR INDICATOR
 *       "stochRsi": {
 *         "k": 65.5,
 *         "d": 62.3,
 *         "state": "bullish"
 *       }
 *     },
 *     // ... other timeframes
 *   }
 * }
 */

// ============================================================================
// DATA TYPE CONSISTENCY
// ============================================================================

// Numbers: Use null for missing values, not 0 or undefined
ema50: tfData.indicators.ema?.ema50 || null,  // ✓ Correct
ema50: tfData.indicators.ema?.ema50 || 0,     // ✗ Wrong (0 is a valid value)

// Strings: Use null or empty string consistently
condition: tfData.indicators.analysis?.condition || null,  // ✓ Correct
condition: tfData.indicators.analysis?.condition || '',    // Also OK

// Objects: Use null or empty object consistently
stochRsi: tfData.indicators.stochRSI || { k: null, d: null, state: 'neutral' },  // ✓ Correct
stochRsi: tfData.indicators.stochRSI || null,  // Also OK if frontend handles null

// ============================================================================
// BACKWARD COMPATIBILITY
// ============================================================================

// When adding new indicators:
// 1. Always use optional chaining: tfData.indicators.ema?.ema50
// 2. Always provide null fallback: || null
// 3. Don't break existing structure
// 4. New indicators are optional - existing code should still work

// Example: Safe addition
timeframes[tf] = {
  // Existing indicators (required)
  trend: (tfData.indicators.analysis?.trend || 'UNKNOWN').toLowerCase(),
  ema21: tfData.indicators.ema?.ema21 || null,
  
  // New indicator (optional - doesn't break if missing)
  ema50: tfData.indicators.ema?.ema50 || null,  // Safe addition
};

// ============================================================================
// TESTING JSON EXPORT
// ============================================================================

// After adding indicator, test:
// 1. Single coin copy button - verify indicator in JSON
// 2. All coins copy button - verify indicator in JSON
// 3. JSON.parse() the exported string - should be valid
// 4. Verify values match displayed values
// 5. Verify null handling works correctly

// Test code:
const jsonString = copyCoinView('BTCUSDT');  // Get JSON string
const json = JSON.parse(jsonString);         // Parse it
console.log(json.timeframes['4h'].ema50);   // Should show your indicator

// ============================================================================
// NOTES:
// ============================================================================
//
// 1. Always use null for missing values (not undefined or 0)
// 2. Use optional chaining (?.) to safely access nested properties
// 3. Maintain consistent structure across all timeframes
// 4. Update ALL export functions, not just one
// 5. Test with insufficient data (indicator should be null)
// 6. Verify JSON is valid (use JSON.parse to test)
//
// ============================================================================

