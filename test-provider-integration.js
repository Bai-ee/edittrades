/**
 * Test Perpetuals Provider Integration
 * Tests Drift, Mango, and Jupiter providers with automatic fallback
 */

import * as perpsProvider from './services/perpsProvider.js';
import 'dotenv/config';

async function testProviderIntegration() {
  console.log('========================================');
  console.log('Testing Perpetuals Provider Integration');
  console.log('========================================\n');

  // Test signal
  const testSignal = {
    valid: true,
    direction: 'long',
    symbol: 'SOLUSDT',
    entryZone: { min: 140, max: 145 },
    stopLoss: 135,
    targets: [150, 160],
    currentPrice: 142.5,
  };

  const testSize = 0.10; // $0.10 USD - very small for testing
  const testLeverage = 1; // 1x leverage for safety

  console.log('Test Parameters:');
  console.log('  Market:', testSignal.symbol);
  console.log('  Direction:', testSignal.direction);
  console.log('  Size:', testSize, 'USD');
  console.log('  Leverage:', testLeverage, 'x');
  console.log('');

  try {
    // Test 1: Get provider info
    console.log('Test 1: Getting provider information...');
    const providerInfo = perpsProvider.getProviderInfo();
    console.log('✅ Available providers:', providerInfo.available.join(', '));
    console.log('✅ Priority order:', providerInfo.priority.join(' → '));
    console.log('✅ Default mode:', providerInfo.default);
    console.log('');

    // Test 2: Get markets from all providers
    console.log('Test 2: Getting markets from all providers...');
    try {
      const markets = await perpsProvider.getPerpMarkets('all');
      console.log('✅ Markets retrieved:');
      for (const [provider, marketData] of Object.entries(markets)) {
        if (marketData.error) {
          console.log(`  ${provider}: ❌ ${marketData.error}`);
        } else {
          console.log(`  ${provider}: ✅ ${marketData.count || marketData.markets?.length || 0} markets`);
        }
      }
      console.log('');
    } catch (error) {
      console.warn('⚠️  Could not get markets:', error.message);
      console.log('');
    }

    // Test 3: Get quote with auto-selection
    console.log('Test 3: Getting quote with auto-selection...');
    try {
      const quote = await perpsProvider.getPerpQuote(
        'auto',
        testSignal.symbol,
        testSignal.direction,
        testSize,
        testLeverage
      );
      console.log('✅ Quote received from:', quote.selectedProvider || quote.provider);
      console.log('  Margin required:', quote.marginRequired, 'USD');
      console.log('  Estimated fee:', quote.estimatedFee || 'N/A', 'USD');
      console.log('');
    } catch (error) {
      console.warn('⚠️  Could not get quote:', error.message);
      console.log('');
    }

    // Test 4: Try opening position with auto-selection
    console.log('Test 4: Opening position with auto-selection (Drift → Mango → Jupiter)...');
    console.log('⚠️  This will attempt to open a real position on Solana mainnet!');
    console.log('');

    try {
      const result = await perpsProvider.openPerpPosition(
        'auto',
        testSignal.symbol,
        testSignal.direction,
        testSize,
        testLeverage,
        testSignal.stopLoss,
        testSignal.targets[0]
      );

      console.log('========================================');
      console.log('✅ POSITION OPENED SUCCESSFULLY!');
      console.log('========================================');
      console.log('Provider used:', result.selectedProvider || result.provider);
      console.log('Fallback used:', result.fallbackUsed ? 'Yes' : 'No');
      console.log('Transaction signature:', result.signature);
      console.log('Position ID:', result.positionId);
      console.log('Market:', result.market || testSignal.symbol);
      console.log('Direction:', result.direction);
      console.log('Size:', result.size, 'USD');
      console.log('Leverage:', result.leverage, 'x');
      console.log('Margin required:', result.marginRequired, 'USD');
      console.log('Explorer URL:', result.explorerUrl);
      console.log('========================================');

      return {
        success: true,
        result,
      };
    } catch (error) {
      console.log('========================================');
      console.log('❌ POSITION OPENING FAILED');
      console.log('========================================');
      console.log('Error:', error.message);
      console.log('Stack:', error.stack);
      console.log('========================================');

      // Try individual providers to see which ones work
      console.log('\nTesting individual providers...\n');

      // Test Drift
      console.log('Testing Drift Protocol...');
      try {
        const driftResult = await perpsProvider.openPerpPosition(
          'drift',
          testSignal.symbol,
          testSignal.direction,
          testSize,
          testLeverage
        );
        console.log('✅ Drift: SUCCESS -', driftResult.signature);
      } catch (driftError) {
        console.log('❌ Drift: FAILED -', driftError.message);
      }

      // Test Mango
      console.log('\nTesting Mango Markets...');
      try {
        const mangoResult = await perpsProvider.openPerpPosition(
          'mango',
          testSignal.symbol,
          testSignal.direction,
          testSize,
          testLeverage
        );
        console.log('✅ Mango: SUCCESS -', mangoResult.signature);
      } catch (mangoError) {
        console.log('❌ Mango: FAILED -', mangoError.message);
      }

      // Test Jupiter
      console.log('\nTesting Jupiter Perpetuals...');
      try {
        const jupiterResult = await perpsProvider.openPerpPosition(
          'jupiter',
          testSignal.symbol,
          testSignal.direction,
          testSize,
          testLeverage
        );
        console.log('✅ Jupiter: SUCCESS -', jupiterResult.signature);
      } catch (jupiterError) {
        console.log('❌ Jupiter: FAILED -', jupiterError.message);
      }

      return {
        success: false,
        error: error.message,
      };
    }
  } catch (error) {
    console.error('Fatal error:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Run test
testProviderIntegration()
  .then((result) => {
    if (result.success) {
      console.log('\n✅ All tests completed successfully!');
      process.exit(0);
    } else {
      console.log('\n❌ Tests completed with errors');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });


