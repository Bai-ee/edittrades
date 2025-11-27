/**
 * Frontend Template-Based Strategy Evaluation
 * 
 * This file contains the logic for evaluating trade signals based on
 * different trading templates (4H, Swing, Scalp) used in the frontend.
 * 
 * Extracted from public/index.html
 */

// Trade Templates Definition
const tradeTemplates = {
  '4h': {
    label: '4H Set & Forget',
    anchorTimeframes: ['4h'],
    confirmTimeframes: ['1h'],
    entryTimeframes: ['15m', '5m'],
    minConfidence: 0.7,
    maxLeverage: 50,
    rrTargets: [1.0, 2.0],
    maxTradesPerDay: 1,
    displayName: '4 HOUR'
  },
  'Swing': {
    label: 'Daily / 4H Swing',
    anchorTimeframes: ['1d', '4h'],
    confirmTimeframes: ['1h'],
    entryTimeframes: ['15m'],
    minConfidence: 0.75,
    maxLeverage: 10,
    rrTargets: [2.0, 3.0],
    maxHoldCandles: { '4h': 20 },
    displayName: 'SWING'
  },
  'Scalp': {
    label: '15m / 5m Scalp',
    anchorTimeframes: ['1h', '15m'],
    confirmTimeframes: ['15m'],
    entryTimeframes: ['5m'],
    minConfidence: 0.65,
    maxLeverage: 25,
    rrTargets: [1.0, 1.5],
    maxHoldCandles: { '5m': 12 },
    displayName: 'SCALP'
  }
};

/**
 * Evaluate signal based on template
 * 
 * @param {string} symbol - Trading pair symbol (e.g., 'BTCUSDT')
 * @param {string} templateKey - Template key ('4h', 'Swing', or 'Scalp')
 * @param {object} scanResults - Object containing analysis data for the symbol
 * @returns {object} Trade signal with valid, direction, confidence, etc.
 */
function evaluateTemplateSignal(symbol, templateKey, scanResults) {
  const data = scanResults[symbol];
  if (!data || !data.analysis) return null;
  
  const template = tradeTemplates[templateKey];
  const analysis = data.analysis;
  
  // Check anchor timeframe trends
  let anchorTrend = null;
  for (const tf of template.anchorTimeframes) {
    const tfData = analysis[tf];
    if (tfData && tfData.indicators && tfData.indicators.analysis) {
      const trend = tfData.indicators.analysis.trend;
      if (trend && trend !== 'FLAT') {
        anchorTrend = trend;
        break;
      }
    }
  }
  
  if (!anchorTrend) {
    return {
      valid: false,
      direction: 'NO_TRADE',
      reason: `No clear trend on ${template.anchorTimeframes.join('/')} anchor`,
      confidence: 0
    };
  }
  
  // Check confirmation timeframes alignment
  let confirmsAlign = true;
  for (const tf of template.confirmTimeframes) {
    const tfData = analysis[tf];
    if (tfData && tfData.indicators && tfData.indicators.analysis) {
      const trend = tfData.indicators.analysis.trend;
      if (trend && trend !== anchorTrend && trend !== 'FLAT') {
        confirmsAlign = false;
        break;
      }
    }
  }
  
  if (!confirmsAlign) {
    return {
      valid: false,
      direction: 'NO_TRADE',
      reason: `Confirmation timeframes don't align with ${anchorTrend}`,
      confidence: 0
    };
  }
  
  // If we have a valid 4h trade signal, use it
  const originalSignal = data.tradeSignal;
  if (originalSignal && originalSignal.valid && templateKey === '4h') {
    return originalSignal;
  }
  
  // For Swing/Scalp, create a basic signal
  const direction = anchorTrend === 'UPTREND' ? 'long' : 'short';
  let confidence = 0.5; // Base confidence
  
  // Increase confidence based on alignment
  if (confirmsAlign) confidence += 0.2;
  
  // Calculate entry zone based on current price and 21 EMA
  const primaryTf = template.anchorTimeframes[0];
  const primaryData = analysis[primaryTf];
  let entryZone = originalSignal?.entryZone || null;
  let stopLoss = originalSignal?.stopLoss || null;
  
  if (primaryData && primaryData.indicators && primaryData.indicators.ema) {
    const ema21 = primaryData.indicators.ema.ema21;
    const currentPrice = data.currentPrice;
    const distanceFrom21 = Math.abs(
      ((currentPrice - ema21) / currentPrice) * 100
    );
    
    if (distanceFrom21 < 2) {
      confidence += 0.15;
    }
    
    // Calculate entry zone around 21 EMA (±1%)
    if (!entryZone) {
      entryZone = {
        min: ema21 * 0.99,
        max: ema21 * 1.01
      };
    }
    
    // Calculate stop loss from swing high/low if available
    if (!stopLoss && primaryData.indicators.swings) {
      if (direction === 'long') {
        stopLoss = primaryData.indicators.swings.swingLow || (currentPrice * 0.95);
      } else {
        stopLoss = primaryData.indicators.swings.swingHigh || (currentPrice * 1.05);
      }
    }
  }
  
  // Cap confidence at template minimum
  confidence = Math.max(confidence, template.minConfidence);
  
  return {
    valid: confidence >= template.minConfidence,
    direction: direction,
    confidence: Math.min(confidence, 0.95),
    reason: `${template.label}: ${anchorTrend}, aligned confirmation`,
    entryZone: entryZone,
    stopLoss: stopLoss,
    targets: {
      tp1: null,
      tp2: null
    },
    riskReward: {
      tp1RR: template.rrTargets[0],
      tp2RR: template.rrTargets[1]
    }
  };
}

/**
 * Strategy Options and States
 * Used for cycling through different strategies in the UI
 */
const strategyOptions = ['4h', 'Swing', 'Scalp'];
const strategyStates = {}; // Tracks which strategy is active for each symbol

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tradeTemplates,
    evaluateTemplateSignal,
    strategyOptions
  };
}

