#!/usr/bin/env node

/**
 * Check Wallet Balances
 * Shows both SOL and USDC balances
 * 
 * Usage: node scripts/check-balances.js
 */

import { PublicKey } from '@solana/web3.js';
import * as walletManager from '../services/walletManager.js';
import 'dotenv/config';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function checkBalances() {
  try {
    console.log('💰 Checking Wallet Balances\n');
    console.log('='.repeat(60));
    
    const wallet = walletManager.getWallet();
    const connection = walletManager.getConnection();
    const address = walletManager.getWalletAddress();
    
    console.log('\n📝 Wallet Address:');
    console.log('  ', address);
    
    // Check SOL balance
    console.log('\n💎 SOL Balance:');
    const solBalance = await walletManager.getBalance();
    console.log('   ', solBalance, 'SOL');
    
    if (solBalance < 0.01) {
      console.log('   ⚠️  Low SOL balance! You need SOL for transaction fees.');
      console.log('   Recommended: 0.01-0.05 SOL');
    } else {
      const estimatedTrades = Math.floor(solBalance / 0.000005);
      console.log('   ✅ Sufficient for ~' + estimatedTrades + ' transactions');
    }
    
    // Check USDC balance
    console.log('\n💵 USDC Balance:');
    try {
      const usdcMintPubkey = new PublicKey(USDC_MINT);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: usdcMintPubkey }
      );
      
      if (tokenAccounts.value.length > 0) {
        const usdcAccount = tokenAccounts.value[0];
        const balance = usdcAccount.account.data.parsed.info.tokenAmount.uiAmount;
        const decimals = usdcAccount.account.data.parsed.info.tokenAmount.decimals;
        
        console.log('   ', balance.toFixed(2), 'USDC');
        
        if (balance < 10) {
          console.log('   ⚠️  Low USDC balance for trading');
          console.log('   Recommended: $50-100 for testing');
        } else {
          console.log('   ✅ Sufficient for trading');
        }
      } else {
        console.log('   0 USDC (no token account found)');
        console.log('   💡 Send USDC to this wallet to create token account');
      }
    } catch (error) {
      console.log('   ❌ Error checking USDC:', error.message);
      console.log('   This is normal if wallet has no USDC yet');
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('\n📊 Summary:\n');
    
    if (solBalance < 0.01) {
      console.log('⚠️  ACTION NEEDED: Fund wallet with SOL for transaction fees');
      console.log('   Send SOL to:', address);
      console.log('   Recommended: 0.01-0.05 SOL');
    } else {
      console.log('✅ SOL balance sufficient for transaction fees');
    }
    
    try {
      const usdcMintPubkey = new PublicKey(USDC_MINT);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey,
        { mint: usdcMintPubkey }
      );
      
      if (tokenAccounts.value.length === 0) {
        console.log('💡 TIP: Send USDC to start trading');
        console.log('   Send USDC to:', address);
        console.log('   Make sure to use Solana network (not Ethereum!)');
        console.log('   Recommended: $50-100 USDC for testing');
      } else {
        const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
        if (balance < 10) {
          console.log('💡 TIP: Consider adding more USDC for trading');
        }
      }
    } catch (error) {
      // Ignore USDC check errors
    }
    
    console.log('\n✅ Balance check complete!\n');
    
  } catch (error) {
    console.error('\n❌ Error checking balances:', error.message);
    process.exit(1);
  }
}

checkBalances();

