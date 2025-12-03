#!/usr/bin/env node

/**
 * Test script to verify htfBias TDZ error is fixed
 * Tests AGGRESSIVE mode strategy evaluation with the same context that was failing
 */

import { evaluateAllStrategies } from './services/strategy.js';

// Mock data similar to the error case
const mockMultiTimeframeData = {
  '1M': {
    indicators: {
      analysis: { trend: 'FLAT' },
      ema: { ema21: 87049.58, ema200: null },
      stochRSI: { k: null, d: null, condition: 'OVERSOLD' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: null, swingLow: null }
  },
  '1w': {
    indicators: {
      analysis: { trend: 'FLAT' },
      ema: { ema21: 105304.65, ema200: null },
      stochRSI: { k: 3.35, d: 1.12, condition: 'OVERSOLD' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: null, swingLow: null }
  },
  '3d': {
    indicators: {
      analysis: { trend: 'FLAT' },
      ema: { ema21: 99992.66, ema200: 87584.31 },
      stochRSI: { k: 35.13, d: 27.76, condition: 'NEUTRAL' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: null, swingLow: null }
  },
  '1d': {
    indicators: {
      analysis: { trend: 'FLAT' },
      ema: { ema21: 92366.41, ema200: 104394.18 },
      stochRSI: { k: 85.06, d: 82.65, condition: 'OVERBOUGHT' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: null, swingLow: null }
  },
  '4h': {
    indicators: {
      analysis: { 
        trend: 'FLAT',
        pullbackState: 'NEUTRAL',
        distanceFrom21EMA: 0.5
      },
      ema: { ema21: 90256.29, ema200: 95366.31 },
      stochRSI: { k: 100, d: 99.09, condition: 'OVERBOUGHT' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: 93500, swingLow: 92000 }
  },
  '1h': {
    indicators: {
      analysis: { 
        trend: 'UPTREND',
        pullbackState: 'RETRACING',
        distanceFrom21EMA: 0.3
      },
      ema: { ema21: 92107.82, ema200: 89716.34 },
      stochRSI: { k: 6.31, d: 6.25, condition: 'OVERSOLD' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: 93200, swingLow: 92000 }
  },
  '15m': {
    indicators: {
      analysis: { 
        trend: 'UPTREND',
        pullbackState: 'ENTRY_ZONE',
        distanceFrom21EMA: 0.1
      },
      ema: { ema21: 93010.10, ema200: 90526.50 },
      stochRSI: { k: 80.79, d: 68.94, condition: 'NEUTRAL' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: 93200, swingLow: 93000 }
  },
  '5m': {
    indicators: {
      analysis: { 
        trend: 'UPTREND',
        pullbackState: 'ENTRY_ZONE',
        distanceFrom21EMA: 0.05
      },
      ema: { ema21: 93065.06, ema200: 92409.03 },
      stochRSI: { k: 80.23, d: 92.78, condition: 'OVERBOUGHT' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: 93200, swingLow: 93050 }
  },
  '3m': {
    indicators: {
      analysis: { 
        trend: 'UPTREND',
        pullbackState: 'ENTRY_ZONE',
        distanceFrom21EMA: 0.02
      },
      ema: { ema21: 90773.56, ema200: 89915.57 },
      stochRSI: { k: 99.99, d: 96.74, condition: 'OVERBOUGHT' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: 93200, swingLow: 93100 }
  },
  '1m': {
    indicators: {
      analysis: { trend: 'FLAT' },
      ema: { ema21: 93177.72, ema200: 93044.13 },
      stochRSI: { k: null, d: 3.09, condition: 'OVERSOLD' },
      price: { current: 93141.5 }
    },
    structure: { swingHigh: null, swingLow: null }
  }
};

const mockMarketData = {
  spread: 0,
  spreadPercent: 0,
  bid: 93141.5,
  ask: 93141.5,
  bidAskImbalance: 0,
  volumeQuality: 'MEDIUM',
  tradeCount24h: 0,
  orderBook: { bidLiquidity: null, askLiquidity: null, imbalance: null },
  recentTrades: { overallFlow: 'N/A', buyPressure: null, sellPressure: null, volumeImbalance: null },
  apiWorking: false
};

const mockDflowData = {
  symbol: 'BTCUSDT',
  ticker: 'BTC',
  events: [],
  markets: [],
  message: 'No prediction markets found for this symbol'
};

async function testHTFBiasTDZFix() {
  console.log('🧪 Testing htfBias TDZ Error Fix\n');
  console.log('='.repeat(60));
  
  const symbol = 'BTCUSDT';
  const mode = 'AGGRESSIVE';
  
  console.log(`\n📊 Test Configuration:`);
  console.log(`   Symbol: ${symbol}`);
  console.log(`   Mode: ${mode}`);
  console.log(`   Current Price: ${mockMultiTimeframeData['4h'].indicators.price.current}`);
  console.log(`   4H Trend: ${mockMultiTimeframeData['4h'].indicators.analysis.trend}`);
  console.log(`   1H Trend: ${mockMultiTimeframeData['1h'].indicators.analysis.trend}`);
  console.log(`   15m Trend: ${mockMultiTimeframeData['15m'].indicators.analysis.trend}`);
  
  console.log(`\n🔍 Running strategy evaluation...\n`);
  
  try {
    const startTime = Date.now();
    const result = await evaluateAllStrategies(
      symbol,
      mockMultiTimeframeData,
      mode,
      mockMarketData,
      mockDflowData
    );
    const duration = Date.now() - startTime;
    
    console.log(`✅ Strategy evaluation completed in ${duration}ms\n`);
    console.log('='.repeat(60));
    
    // Check for TDZ errors in strategy results
    let hasTDZError = false;
    const errorMessages = [];
    
    for (const [strategyName, strategyResult] of Object.entries(result.strategies || {})) {
      if (strategyResult && strategyResult.reason) {
        const reason = strategyResult.reason;
        if (reason.includes('Cannot access') && reason.includes('before initialization')) {
          hasTDZError = true;
          errorMessages.push(`${strategyName}: ${reason}`);
        }
        if (reason.includes('htfBias') && reason.includes('initialization')) {
          hasTDZError = true;
          errorMessages.push(`${strategyName}: ${reason}`);
        }
      }
    }
    
    if (hasTDZError) {
      console.error('\n❌ TDZ ERROR DETECTED!\n');
      errorMessages.forEach(msg => console.error(`   ${msg}`));
      process.exit(1);
    } else {
      console.log('\n✅ NO TDZ ERRORS DETECTED!\n');
    }
    
    // Display strategy results summary
    console.log('📋 Strategy Results Summary:\n');
    for (const [strategyName, strategyResult] of Object.entries(result.strategies || {})) {
      const valid = strategyResult?.valid ? '✅' : '❌';
      const direction = strategyResult?.direction || 'NO_TRADE';
      const confidence = strategyResult?.confidence || 0;
      const reason = strategyResult?.reason || 'N/A';
      
      console.log(`   ${valid} ${strategyName}:`);
      console.log(`      Direction: ${direction}`);
      console.log(`      Confidence: ${confidence}%`);
      console.log(`      Reason: ${reason.substring(0, 80)}${reason.length > 80 ? '...' : ''}`);
      console.log('');
    }
    
    // Check bestSignal
    if (result.bestSignal) {
      console.log(`\n🎯 Best Signal: ${result.bestSignal.direction || 'NO_TRADE'}`);
      console.log(`   Confidence: ${result.bestSignal.confidence || 0}%`);
    } else {
      console.log(`\n🎯 Best Signal: None`);
    }
    
    // Verify htfBias is present in context
    console.log(`\n🔍 Context Verification:`);
    if (result.htfBias) {
      console.log(`   ✅ htfBias present: ${result.htfBias.direction} (${result.htfBias.confidence}%)`);
    } else {
      console.log(`   ⚠️  htfBias missing from result`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ TEST PASSED: No TDZ errors detected!\n');
    
  } catch (error) {
    console.error('\n❌ TEST FAILED: Exception thrown during evaluation\n');
    console.error(`   Error: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);
    
    // Check if it's a TDZ error
    if (error.message.includes('Cannot access') && error.message.includes('before initialization')) {
      console.error('\n   ⚠️  This is a TDZ error - the fix did not work!');
      process.exit(1);
    }
    
    process.exit(1);
  }
}

// Run the test
testHTFBiasTDZFix().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

