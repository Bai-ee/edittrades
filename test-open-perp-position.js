/**
 * Test Opening a Small Perp Position
 * Opens a real perp position with USDT collateral, 1x leverage, small amount
 */

import 'dotenv/config';
import * as perpsProvider from './services/perpsProvider.js';
import { getWallet, getConnection, getWalletAddress } from './services/walletManager.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

async function testOpenPerpPosition() {
  try {
    console.log('🧪 Testing Perp Position Opening...\n');
    console.log('='.repeat(60));
    
    // Check wallet
    const wallet = getWallet();
    const walletAddress = wallet.publicKey.toBase58();
    console.log('💰 Wallet Address:', walletAddress);
    
    const connection = getConnection();
    const solBalance = await connection.getBalance(wallet.publicKey);
    console.log('💎 SOL Balance:', (solBalance / 1e9).toFixed(4), 'SOL');
    
    // Check USDT balance
    const USDT_MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
    const usdtAta = getAssociatedTokenAddressSync(USDT_MINT, wallet.publicKey);
    
    try {
      const usdtAccount = await connection.getTokenAccountBalance(usdtAta);
      const usdtBalance = parseFloat(usdtAccount.value.amount) / 1e6; // USDT has 6 decimals
      console.log('💵 USDT Balance:', usdtBalance.toFixed(2), 'USDT');
      
      if (usdtBalance < 0.1) {
        console.warn('⚠️  Low USDT balance! Recommended: at least $0.10 USDT');
      }
    } catch (error) {
      console.warn('⚠️  Could not check USDT balance (account may not exist yet):', error.message);
      console.log('   The system will create the USDT account automatically if needed.');
    }
    
    console.log('='.repeat(60));
    console.log('\n📊 Opening Test Position...\n');
    
    // Test parameters - small, safe test
    // Try ETHUSDT first (lower custody utilization than BTC)
    const testParams = {
      market: 'ETHUSDT',      // ETH has lower custody utilization ($306K vs BTC's $4.8M)
      direction: 'long',      // Long position
      size: 1.0,              // $1 position size
      leverage: 1,            // 1x leverage (no leverage)
      stopLoss: null,         // Optional
      takeProfit: null        // Optional
    };
    
    console.log('📋 Position Parameters:');
    console.log('   Market:', testParams.market);
    console.log('   Direction:', testParams.direction);
    console.log('   Position Size:', `$${testParams.size}`);
    console.log('   Leverage:', `${testParams.leverage}x`);
    console.log('   Margin Required:', `$${(testParams.size / testParams.leverage).toFixed(2)}`);
    console.log('\n');
    
    // Open the position using perpsProvider with auto-fallback
    // This will try Drift first, then Mango, then Jupiter
    console.log('🚀 Executing trade with auto-provider selection...');
    console.log('   (Will try: Drift → Mango → Jupiter)\n');
    const result = await perpsProvider.openPerpPosition(
      'auto',  // Auto-select provider with fallback
      testParams.market,
      testParams.direction,
      testParams.size,
      testParams.leverage,
      testParams.stopLoss,
      testParams.takeProfit
    );
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ POSITION OPENED SUCCESSFULLY!');
    console.log('='.repeat(60));
    console.log('\n📊 Position Details:');
    console.log('   Provider Used:', result.selectedProvider || result.provider || 'unknown');
    if (result.fallbackUsed) {
      console.log('   ⚠️  Fallback provider used (primary provider unavailable)');
    }
    console.log('   Position ID:', result.positionId);
    console.log('   Transaction Signature:', result.signature);
    console.log('   Explorer URL:', result.explorerUrl);
    console.log('   Market:', result.market);
    console.log('   Direction:', result.direction);
    console.log('   Size:', `$${result.size.toFixed(2)}`);
    console.log('   Leverage:', `${result.leverage}x`);
    console.log('   Margin Required:', `$${result.marginRequired.toFixed(2)}`);
    if (result.liquidationPrice) {
      console.log('   Liquidation Price:', `$${result.liquidationPrice.toFixed(2)}`);
    }
    console.log('\n');
    
    return result;
    
  } catch (error) {
    console.error('\n❌ ERROR Opening Position:');
    console.error('   Message:', error.message);
    if (error.stack) {
      console.error('\n   Stack:', error.stack);
    }
    
    // Provide helpful error messages
    if (error.message.includes('CustodyAmountLimit')) {
      console.error('\n💡 Tip: Try a different market (ETHUSDT or BTCUSDT) or smaller size');
    } else if (error.message.includes('AccountNotInitialized')) {
      console.error('\n💡 Tip: The USDT account will be created automatically. This error may resolve on retry.');
    } else if (error.message.includes('Insufficient')) {
      console.error('\n💡 Tip: Ensure you have enough USDT in your wallet for margin + fees');
    }
    
    throw error;
  }
}

// Run the test
testOpenPerpPosition()
  .then(() => {
    console.log('\n✅ Test completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error.message);
    process.exit(1);
  });

