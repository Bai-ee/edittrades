/**
 * Local test script to verify SAFE mode override logic
 * Run with: node test-strategy-override.js
 */

// Mock the strategy evaluation with test data
const mockMultiTimeframeData = {
  '4h': {
    indicators: {
      analysis: { trend: 'FLAT' },
      price: { current: 91371 },
      ema: { ema21: 91000, ema200: 90000 }
    }
  },
  '1h': {
    indicators: {
      analysis: { trend: 'UPTREND' },
      price: { current: 91371 },
      ema: { ema21: 91200, ema200: 90500 },
      stochRSI: { k: 54.1, d: 60, condition: 'BULLISH' }
    }
  },
  '15m': {
    indicators: {
      analysis: { trend: 'UPTREND' },
      price: { current: 91371 },
      ema: { ema21: 91300, ema200: 90800 },
      stochRSI: { k: 45, d: 50, condition: 'BULLISH' }
    }
  },
  '5m': {
    indicators: {
      analysis: { trend: 'UPTREND' },
      ema: { ema21: 91350 }
    }
  },
  '1d': {
    indicators: {
      analysis: { trend: 'UPTREND' },
      ema: { ema21: 90000 }
    }
  },
  '3d': {
    indicators: {
      analysis: { trend: 'UPTREND' }
    }
  }
};

const mockMarketData = {
  volumeQuality: 'MEDIUM',
  spread: 0.5,
  bidAskImbalance: 0
};

const mockDflowData = null;

// Import strategy functions (adjust path as needed)
import { evaluateStrategy, evaluateAllStrategies } from './services/strategy.js';

console.log('🧪 Testing SAFE Mode Override Logic\n');
console.log('Test Conditions:');
console.log('- HTF bias: long @ 60%');
console.log('- 1H trend: UPTREND');
console.log('- 15m trend: UPTREND');
console.log('- 1H Stoch K: 54.1 (< 60, should pass)');
console.log('- 4H trend: FLAT (should trigger override)\n');

// Test TREND_4H strategy
console.log('📊 Testing TREND_4H strategy...');
try {
  const result = evaluateStrategy('BTCUSDT', mockMultiTimeframeData, '4h', 'STANDARD', mockMarketData, mockDflowData);
  console.log('Result:', JSON.stringify(result, null, 2));
  
  console.log('\n📋 TREND_4H Result Summary:');
  console.log('- Valid:', result?.valid || false);
  console.log('- Direction:', result?.direction || 'NO_TRADE');
  console.log('- Confidence:', result?.confidence || 0);
  console.log('- Override:', result?.override || false);
  console.log('- Notes:', result?.notes || []);
  console.log('- Reason:', result?.reason || 'N/A');
  
  if (result && result.valid) {
    console.log('\n✅ TREND_4H returned valid signal');
    if (result.override) {
      console.log('✅ Override flag is set');
    } else {
      console.log('❌ Override flag is missing');
    }
    if (result.notes && result.notes.length > 0) {
      console.log('✅ Override notes present:', result.notes);
    } else {
      console.log('❌ Override notes missing');
    }
  } else {
    console.log('\n❌ TREND_4H returned invalid signal');
    console.log('Reason:', result?.reason || 'Unknown');
  }
} catch (error) {
  console.error('❌ Error testing TREND_4H:', error.message);
  console.error('Stack:', error.stack);
}

console.log('\n📊 Testing evaluateAllStrategies...');
try {
  const allResults = evaluateAllStrategies('BTCUSDT', mockMultiTimeframeData, 'STANDARD', mockMarketData, mockDflowData);
  console.log('Strategies evaluated:', Object.keys(allResults.strategies || {}));
  
  const validStrategies = Object.entries(allResults.strategies || {})
    .filter(([_, s]) => s && s.valid === true);
  
  if (validStrategies.length > 0) {
    console.log('✅ Found valid strategies:', validStrategies.map(([name]) => name));
    validStrategies.forEach(([name, strategy]) => {
      if (strategy.override) {
        console.log(`✅ ${name} has override flag`);
      }
      if (strategy.notes && strategy.notes.length > 0) {
        console.log(`✅ ${name} has notes:`, strategy.notes);
      }
    });
  } else {
    console.log('❌ No valid strategies found');
    console.log('All strategies:', Object.entries(allResults.strategies || {}).map(([name, s]) => ({
      name,
      valid: s?.valid,
      reason: s?.reason
    })));
  }
  
  if (allResults.bestSignal) {
    console.log('✅ Best signal found:', allResults.bestSignal.direction);
  } else {
    console.log('❌ No best signal');
  }
  
  // Output full JSON for the first valid strategy
  if (validStrategies.length > 0) {
    const [strategyName, strategyData] = validStrategies[0];
    console.log('\n📄 Example JSON Output for', strategyName, ':');
    console.log(JSON.stringify(strategyData, null, 2));
  }
  
  // Also output the full allResults structure
  console.log('\n📄 Full evaluateAllStrategies JSON Output:');
  console.log(JSON.stringify(allResults, null, 2));
} catch (error) {
  console.error('❌ Error testing evaluateAllStrategies:', error.message);
  console.error('Stack:', error.stack);
}

console.log('\n✅ Test complete');

