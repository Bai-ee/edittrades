#!/usr/bin/env node

/**
 * Test Jupiter Integration
 * Tests wallet, token mapping, and swap quote retrieval (no execution)
 * Run with: node test-jupiter-integration.js
 */

import * as walletManager from './services/walletManager.js';
import * as tokenMapping from './services/tokenMapping.js';
import * as jupiterSwap from './services/jupiterSwap.js';
import 'dotenv/config';

async function testJupiterIntegration() {
  console.log('🧪 Testing Jupiter Integration\n');
  console.log('='.repeat(60));
  
  let allTestsPassed = true;
  
  // Test 1: Wallet Management
  console.log('\n📦 Test 1: Wallet Management');
  try {
    const wallet = walletManager.getWallet();
    const address = walletManager.getWalletAddress();
    const connection = walletManager.getConnection();
    
    console.log('✅ Wallet loaded');
    console.log('   Address:', address);
    
    const balance = await walletManager.getBalance();
    console.log('✅ Balance retrieved:', balance, 'SOL');
    
    if (balance < 0.01) {
      console.warn('⚠️  Low balance! Ensure wallet has enough SOL for transaction fees.');
    }
    
    const verified = await walletManager.verifyWallet();
    if (!verified) {
      throw new Error('Wallet verification failed');
    }
    
    console.log('✅ Wallet verified');
  } catch (error) {
    console.error('❌ Wallet test failed:', error.message);
    allTestsPassed = false;
  }
  
  // Test 2: Token Mapping
  console.log('\n📦 Test 2: Token Mapping');
  try {
    const testSymbols = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'USDC'];
    
    for (const symbol of testSymbols) {
      const address = tokenMapping.getTokenAddress(symbol);
      const decimals = tokenMapping.getTokenDecimals(symbol);
      const supported = tokenMapping.isSymbolSupported(symbol);
      
      if (!address || !supported) {
        throw new Error(`Token mapping failed for ${symbol}`);
      }
      
      console.log(`✅ ${symbol}:`);
      console.log(`   Address: ${address}`);
      console.log(`   Decimals: ${decimals}`);
      
      // Test amount conversion
      const testAmount = 1.5;
      const smallestUnit = tokenMapping.toTokenAmount(testAmount, symbol);
      const backToHuman = tokenMapping.fromTokenAmount(smallestUnit, symbol);
      
      if (Math.abs(backToHuman - testAmount) > 0.0001) {
        throw new Error(`Amount conversion failed for ${symbol}`);
      }
      
      console.log(`   Amount conversion: ${testAmount} → ${smallestUnit} → ${backToHuman} ✅`);
    }
    
    console.log('✅ Token mapping tests passed');
  } catch (error) {
    console.error('❌ Token mapping test failed:', error.message);
    allTestsPassed = false;
  }
  
  // Test 3: Jupiter Swap Quote (No Execution)
  console.log('\n📦 Test 3: Jupiter Swap Quote (No Execution)');
  try {
    const solAddress = tokenMapping.getTokenAddress('SOLUSDT');
    const usdcAddress = tokenMapping.getTokenAddress('USDC');
    
    if (!solAddress || !usdcAddress) {
      throw new Error('Token addresses not found');
    }
    
    // Test quote for 0.1 SOL to USDC
    const solAmount = 0.1;
    const solAmountSmallest = tokenMapping.toTokenAmount(solAmount, 'SOLUSDT');
    
    console.log('   Requesting quote: 0.1 SOL → USDC');
    console.log('   Input mint:', solAddress);
    console.log('   Output mint:', usdcAddress);
    console.log('   Amount (smallest unit):', solAmountSmallest);
    
    const quote = await jupiterSwap.getSwapQuote(
      solAddress,
      usdcAddress,
      solAmountSmallest,
      50 // 0.5% slippage
    );
    
    if (!quote || !quote.outAmount) {
      throw new Error('Invalid quote response');
    }
    
    console.log('✅ Quote received:');
    console.log('   Output amount:', quote.outAmount);
    console.log('   Price impact:', quote.priceImpactPct || 'N/A', '%');
    console.log('   Route:', quote.routePlan ? 'Multi-hop' : 'Direct');
    
    // Convert output to human-readable
    const usdcOutput = tokenMapping.fromTokenAmount(quote.outAmount, 'USDC');
    console.log('   Output (USDC):', usdcOutput.toFixed(2));
    
  } catch (error) {
    console.error('❌ Swap quote test failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
    allTestsPassed = false;
  }
  
  // Test 4: Transaction Building (No Signing)
  console.log('\n📦 Test 4: Transaction Building (No Signing)');
  try {
    const solAddress = tokenMapping.getTokenAddress('SOLUSDT');
    const usdcAddress = tokenMapping.getTokenAddress('USDC');
    const solAmountSmallest = tokenMapping.toTokenAmount(0.1, 'SOLUSDT');
    
    // Get quote first
    const quote = await jupiterSwap.getSwapQuote(
      solAddress,
      usdcAddress,
      solAmountSmallest,
      50
    );
    
    // Build transaction
    const walletAddress = walletManager.getWalletAddress();
    console.log('   Building transaction for wallet:', walletAddress);
    
    const transaction = await jupiterSwap.buildSwapTransaction(quote, walletAddress);
    
    if (!transaction) {
      throw new Error('Transaction build failed');
    }
    
    console.log('✅ Transaction built successfully');
    console.log('   Transaction size:', transaction.serialize().length, 'bytes');
    console.log('   ⚠️  Note: Transaction not signed or sent (test mode)');
    
  } catch (error) {
    console.error('❌ Transaction build test failed:', error.message);
    if (error.response) {
      console.error('   Response status:', error.response.status);
      console.error('   Response data:', error.response.data);
    }
    allTestsPassed = false;
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  if (allTestsPassed) {
    console.log('\n✅ All tests passed!');
    console.log('\n📝 Next steps:');
    console.log('   1. Ensure wallet has sufficient SOL for actual trades');
    console.log('   2. Test with small amounts first');
    console.log('   3. Monitor transaction fees');
    console.log('   4. Check Jupiter API rate limits');
  } else {
    console.log('\n❌ Some tests failed. Please review errors above.');
    process.exit(1);
  }
}

// Run tests
testJupiterIntegration().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

