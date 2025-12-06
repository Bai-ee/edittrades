/**
 * Test Jupiter Perps Wrapper Connection
 * Tests the CommonJS wrapper workaround for jup-perps-client
 */

import 'dotenv/config';

async function testPerpsWrapper() {
  try {
    console.log('🧪 Testing Jupiter Perps Wrapper...\n');
    
    // Test 1: Import wrapper
    console.log('📦 Test 1: Importing CommonJS wrapper...');
    const jupPerpsClient = await import('./services/jup-perps-wrapper.cjs');
    console.log('✅ Wrapper imported successfully');
    console.log('   Available exports:', Object.keys(jupPerpsClient.default || jupPerpsClient).slice(0, 10).join(', '), '...');
    
    // Test 2: Import jupiterPerps service
    console.log('\n📦 Test 2: Importing jupiterPerps service...');
    const { getPerpMarkets, getPerpQuote } = await import('./services/jupiterPerps.js');
    console.log('✅ Service imported successfully');
    
    // Test 3: Fetch markets
    console.log('\n📊 Test 3: Fetching Perpetual Markets...');
    const markets = await getPerpMarkets();
    console.log('✅ Markets fetched successfully');
    console.log('   Number of markets:', Object.keys(markets).length);
    for (const [symbol, market] of Object.entries(markets)) {
      console.log(`\n   ${symbol}:`);
      console.log('   - Custody Address:', market.custodyAddress);
      console.log('   - Token Mint:', market.tokenMint);
      console.log('   - Decimals:', market.decimals);
      console.log('   - Max Leverage:', market.maxLeverage, 'x');
    }
    
    // Test 4: Get quote
    console.log('\n💰 Test 4: Getting Perpetual Quote...');
    const quote = await getPerpQuote('SOLUSDT', 'long', 10, 5);
    console.log('✅ Quote calculated successfully');
    console.log('   Market: SOLUSDT');
    console.log('   Direction: long');
    console.log('   Size: $10 USD');
    console.log('   Leverage: 5x');
    console.log('   Margin Required: $' + quote.marginRequired.toFixed(2));
    console.log('   Estimated Fees: $' + quote.estimatedFees.toFixed(4));
    
    // Test 5: Check wallet
    console.log('\n👛 Test 5: Checking Wallet...');
    const { getWallet } = await import('./services/walletManager.js');
    const wallet = getWallet();
    console.log('✅ Wallet loaded');
    console.log('   Address:', wallet.publicKey.toBase58());
    
    console.log('\n✅ All tests passed! Wrapper workaround is working correctly.');
    console.log('\n📝 Status:');
    console.log('   ✅ CommonJS wrapper working');
    console.log('   ✅ Pool and custody data fetching working');
    console.log('   ✅ Market discovery working');
    console.log('   ✅ Quote calculation working');
    console.log('   ⏳ Full position opening pending (PDA derivation needed)');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testPerpsWrapper();


