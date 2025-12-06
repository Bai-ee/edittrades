/**
 * Test Jupiter Perps Connection
 * Tests the connection to Jupiter Perps and attempts to fetch pool data
 */

import { createSolanaRpc } from '@solana/kit';
import { fetchPool } from 'jup-perps-client/dist/accounts/pool.js';
import { fetchCustody } from 'jup-perps-client/dist/accounts/custody.js';
import { PERPETUALS_PROGRAM_ADDRESS } from 'jup-perps-client/dist/programs/perpetuals.js';
import 'dotenv/config';

const JUPITER_PERPS_POOL = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';

async function testPerpsConnection() {
  try {
    console.log('🧪 Testing Jupiter Perps Connection...\n');
    
    // Create RPC connection
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    console.log('📡 RPC URL:', rpcUrl);
    const rpc = createSolanaRpc(rpcUrl);
    
    // Test 1: Fetch Pool
    console.log('\n📊 Test 1: Fetching Pool Data...');
    const pool = await fetchPool(rpc, JUPITER_PERPS_POOL);
    
    console.log('✅ Pool fetched successfully!');
    console.log('   Pool Name:', pool.data.name);
    console.log('   Number of Custodies:', pool.data.custodies.length);
    console.log('   AUM USD: $' + (Number(pool.data.aumUsd) / 1_000_000).toLocaleString());
    console.log('   Program Address:', PERPETUALS_PROGRAM_ADDRESS);
    
    // Test 2: Fetch Custody Details
    console.log('\n🪙 Test 2: Fetching Custody Details...');
    for (let i = 0; i < Math.min(pool.data.custodies.length, 3); i++) {
      const custodyAddress = pool.data.custodies[i];
      if (!custodyAddress) continue;
      
      try {
        const custody = await fetchCustody(rpc, custodyAddress);
        console.log(`\n   Custody ${i + 1}:`);
        console.log('   - Address:', custodyAddress);
        console.log('   - Token Mint:', custody.data.mint);
        console.log('   - Decimals:', custody.data.decimals);
        console.log('   - Assets Owned:', custody.data.assets.owned.toString());
        console.log('   - Target Ratio:', custody.data.targetRatioBps, 'bps');
      } catch (error) {
        console.error(`   ❌ Error fetching custody ${i + 1}:`, error.message);
      }
    }
    
    // Test 3: Check Wallet
    console.log('\n👛 Test 3: Checking Wallet...');
    const { getWallet } = await import('./services/walletManager.js');
    const wallet = getWallet();
    console.log('✅ Wallet loaded');
    console.log('   Address:', wallet.publicKey.toBase58());
    
    // Test 4: Test Quote Calculation
    console.log('\n💰 Test 4: Testing Quote Calculation...');
    const { getPerpQuote } = await import('./services/jupiterPerps.js');
    const quote = await getPerpQuote('SOLUSDT', 'long', 10, 5);
    console.log('✅ Quote calculated');
    console.log('   Market: SOLUSDT');
    console.log('   Direction: long');
    console.log('   Size: $10 USD');
    console.log('   Leverage: 5x');
    console.log('   Margin Required: $' + quote.marginRequired.toFixed(2));
    console.log('   Estimated Fees: $' + quote.estimatedFees.toFixed(4));
    
    console.log('\n✅ All tests passed! Jupiter Perps connection is working.');
    console.log('\n📝 Next Steps:');
    console.log('   1. Implement full account derivation for position opening');
    console.log('   2. Test position request creation');
    console.log('   3. Test transaction building and signing');
    console.log('   4. Test actual position opening on mainnet');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testPerpsConnection();

