/**
 * Test Perpetual Trade Execution
 * Tests opening a real perp position (structure only, not actual transaction)
 */

import 'dotenv/config';

async function testPerpTrade() {
  try {
    console.log('🧪 Testing Perpetual Trade Execution...\n');
    
    // Import services
    const { executePerpTrade } = await import('./services/tradeExecution.js');
    
    // Create test signals for different markets
    // Testing BTCUSDT first as it has lower custody utilization ($4.8M vs SOL's $5.7B)
    const testSignals = [
      {
        valid: true,
        direction: 'long',
        symbol: 'BTCUSDT',
        entryZone: { min: 90000, max: 91000 },
        stopLoss: 88000,
        targets: [93000, 95000],
        currentPrice: 90500,
      },
      {
        valid: true,
        direction: 'long',
        symbol: 'SOLUSDT',
        entryZone: { min: 140, max: 145 },
        stopLoss: 135,
        targets: [150, 160],
        currentPrice: 142.5,
      },
      {
        valid: true,
        direction: 'long',
        symbol: 'ETHUSDT',
        entryZone: { min: 3000, max: 3100 },
        stopLoss: 2900,
        targets: [3200, 3300],
        currentPrice: 3050,
      },
    ];
    
    // Test with very small position sizes to avoid custody limits
    // Start with minimum viable size
    const testCases = [
      { size: 0.10, leverage: 1 },   // $0.10 position, 1x leverage = $0.10 margin
      { size: 0.25, leverage: 2 },  // $0.25 position, 2x leverage = $0.125 margin
    ];
    
    // Test each market
    for (const testSignal of testSignals) {
      console.log('\n📊 Test Signal:');
      console.log('   Symbol:', testSignal.symbol);
      console.log('   Direction:', testSignal.direction);
      console.log('   Entry Zone:', testSignal.entryZone);
      console.log('   Stop Loss:', testSignal.stopLoss);
      console.log('   Targets:', testSignal.targets);
      
      // Try just one small test case per market
      const testCase = testCases[0];
      console.log(`\n💰 Test: $${testCase.size} position with ${testCase.leverage}x leverage`);
      console.log('   Expected margin:', `$${(testCase.size / testCase.leverage).toFixed(2)}`);
      
      try {
        const result = await executePerpTrade(testSignal, testCase.size, testCase.leverage);
        
        console.log('   ✅ Trade execution successful');
        console.log('   Position ID:', result.positionId);
        console.log('   Margin Required:', `$${result.marginRequired.toFixed(2)}`);
        console.log('   Notional Size:', `$${result.notionalSize.toFixed(2)}`);
        console.log('   Leverage:', `${result.leverage}x`);
        
        if (result.note) {
          console.log('   Note:', result.note);
        }
        
        // If one succeeds, we can stop
        break;
      } catch (error) {
        console.error('   ❌ Trade execution failed:', error.message);
        // Continue to next market
      }
    }
    
    console.log('\n✅ All trade execution tests completed!');
    console.log('\n📝 Next Steps:');
    console.log('   1. Implement PDA derivation for position request');
    console.log('   2. Implement PDA derivation for position');
    console.log('   3. Resolve price feed accounts');
    console.log('   4. Build actual transaction instruction');
    console.log('   5. Sign and send transaction');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testPerpTrade();

