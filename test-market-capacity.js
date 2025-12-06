/**
 * Test capacity across different markets and collateral types
 * Checks USDC vs USDT collateral, different markets, etc.
 */

import 'dotenv/config';
import { checkCustodyCapacity } from './services/jupiterPerps.js';
import { getPerpMarkets } from './services/jupiterPerps.js';

async function testMarketCapacity() {
  try {
    console.log('🔍 Testing Market Capacity Across Different Options...\n');
    
    // First, get all available markets
    console.log('📊 Fetching available markets...');
    const markets = await getPerpMarkets();
    console.log('Available markets:', Object.keys(markets));
    console.log('');
    
    // Test different markets with small position size
    const testSize = 0.10; // $0.10 USD
    const marketsToTest = [
      'SOLUSDT',
      'BTCUSDT', 
      'ETHUSDT',
    ];
    
    console.log('💰 Testing capacity for $' + testSize + ' positions:\n');
    
    for (const market of marketsToTest) {
      if (!markets[market]) {
        console.log(`⏭️  ${market}: Not available in pool`);
        continue;
      }
      
      try {
        console.log(`\n📈 Testing ${market}:`);
        const capacity = await checkCustodyCapacity(market, testSize);
        
        console.log(`   ✅ Capacity check successful`);
        console.log(`   Current assets: $${capacity.currentAssets.toFixed(2)}`);
        console.log(`   Required: $${capacity.requiredSize.toFixed(2)}`);
        console.log(`   Custody: ${capacity.custodyAddress}`);
        
        // Try to see if we can get more info about the custody
        if (capacity.custodyData) {
          console.log(`   Token mint: ${capacity.custodyData.mint}`);
          console.log(`   Decimals: ${capacity.custodyData.decimals}`);
          if (capacity.custodyData.isStable !== undefined) {
            console.log(`   Is stable: ${capacity.custodyData.isStable}`);
          }
        }
      } catch (error) {
        console.error(`   ❌ Error checking ${market}:`, error.message);
      }
    }
    
    // Check all custodies in the pool to see what's available
    console.log('\n\n🔍 Checking All Custodies in Pool:\n');
    for (const [symbol, marketData] of Object.entries(markets)) {
      console.log(`${symbol}:`);
      console.log(`   Custody: ${marketData.custodyAddress}`);
      console.log(`   Token: ${marketData.tokenMint}`);
      console.log(`   Assets owned: ${marketData.assetsOwned}`);
      console.log('');
    }
    
    // Check if USDT is available as collateral
    console.log('\n💵 Checking for USDT Collateral Options:\n');
    const usdtMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    
    // Look through all custodies to find USDT
    let foundUsdt = false;
    let foundUsdc = false;
    
    for (const [symbol, marketData] of Object.entries(markets)) {
      if (marketData.tokenMint === usdtMint) {
        console.log(`✅ Found USDT custody: ${symbol}`);
        console.log(`   Address: ${marketData.custodyAddress}`);
        console.log(`   Assets: ${marketData.assetsOwned}`);
        foundUsdt = true;
      }
      if (marketData.tokenMint === usdcMint) {
        console.log(`✅ Found USDC custody: ${symbol}`);
        console.log(`   Address: ${marketData.custodyAddress}`);
        console.log(`   Assets: ${marketData.assetsOwned}`);
        foundUsdc = true;
      }
    }
    
    if (!foundUsdt) {
      console.log('⚠️  USDT custody not found in markets list');
    }
    if (!foundUsdc) {
      console.log('⚠️  USDC custody not found in markets list');
    }
    
    console.log('\n✅ Market capacity check complete!');
    console.log('\n💡 Next Steps:');
    console.log('   1. Try opening positions with markets that show lower asset utilization');
    console.log('   2. Check if USDT collateral markets have more capacity');
    console.log('   3. Monitor custody assets to see when capacity becomes available');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testMarketCapacity();


