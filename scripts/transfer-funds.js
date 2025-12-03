#!/usr/bin/env node

/**
 * Transfer All Funds Between Wallets
 * Transfers SOL from old wallet to new wallet
 */

import { Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { getConnection } from '../services/walletManager.js';
import 'dotenv/config';

// Old wallet (current in .env)
const OLD_PRIVATE_KEY = 'CWT1QGDPSS5jhgZuuZkYCVKD32AxzT6cnLxy38xQ7Ns9';
const OLD_ADDRESS = '2z6K4fNUsYVwQcqcAawYnMGjBhRVbHmgyYSMD8C3rNVy';

// New wallet (with seed phrase)
const NEW_PRIVATE_KEY = '7UqH8e6JrBVHGw49RGdfaS7Tqj8hphnYU39uWHn8tJCq';
const NEW_ADDRESS = 'JEAzPiuEheUQkK5Q1TLgm7VzuuZHDTzFu1oUwQgTjwT2';

async function transferFunds() {
  try {
    console.log('💸 Transferring Funds Between Wallets\n');
    console.log('='.repeat(60));
    
    const connection = getConnection();
    
    // Load old wallet
    const oldPrivateKeyBytes = bs58.decode(OLD_PRIVATE_KEY);
    const oldSeed = oldPrivateKeyBytes.length === 64 ? oldPrivateKeyBytes.slice(0, 32) : oldPrivateKeyBytes;
    const oldKeypair = Keypair.fromSeed(oldSeed);
    
    // Load new wallet
    const newPrivateKeyBytes = bs58.decode(NEW_PRIVATE_KEY);
    const newSeed = newPrivateKeyBytes.length === 64 ? newPrivateKeyBytes.slice(0, 32) : newPrivateKeyBytes;
    const newKeypair = Keypair.fromSeed(newSeed);
    
    console.log('📝 Wallet Information:\n');
    console.log('From (Old Wallet):');
    console.log('  Address:', oldKeypair.publicKey.toBase58());
    
    console.log('\nTo (New Wallet):');
    console.log('  Address:', newKeypair.publicKey.toBase58());
    
    // Check old wallet balance
    console.log('\n💰 Checking Balances...\n');
    const oldBalance = await connection.getBalance(oldKeypair.publicKey);
    const oldBalanceSOL = oldBalance / LAMPORTS_PER_SOL;
    
    console.log('Old Wallet Balance:', oldBalanceSOL.toFixed(9), 'SOL');
    
    if (oldBalanceSOL < 0.00001) {
      console.log('⚠️  Old wallet has no funds to transfer');
      return;
    }
    
    // Get actual minimum balance for rent exemption
    const minBalanceForRentExemption = await connection.getMinimumBalanceForRentExemption(0);
    const minBalanceSOL = minBalanceForRentExemption / LAMPORTS_PER_SOL;
    
    // Calculate transfer amount
    // Need to leave enough for rent exemption
    // Transaction fee will be deducted from remaining balance
    const TOTAL_RESERVE = minBalanceSOL + 0.00001; // Rent exemption + small buffer for fee
    
    const transferAmountSOL = oldBalanceSOL - TOTAL_RESERVE;
    const transferAmountLamports = Math.floor(transferAmountSOL * LAMPORTS_PER_SOL);
    
    if (transferAmountLamports <= 0) {
      console.log('⚠️  Insufficient balance to transfer');
      return;
    }
    
    console.log('\n📤 Transfer Details:');
    console.log('  Minimum rent exemption:', minBalanceSOL.toFixed(9), 'SOL');
    console.log('  Amount to transfer:', transferAmountSOL.toFixed(9), 'SOL');
    console.log('  Reserve (rent + buffer):', TOTAL_RESERVE.toFixed(9), 'SOL');
    console.log('  Total balance:', oldBalanceSOL.toFixed(9), 'SOL');
    console.log('  Note: Old wallet will be left with ~', minBalanceSOL.toFixed(9), 'SOL (rent exemption)');
    
    // Create transfer transaction
    console.log('\n🔄 Creating transfer transaction...');
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: oldKeypair.publicKey,
        toPubkey: newKeypair.publicKey,
        lamports: transferAmountLamports,
      })
    );
    
    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = oldKeypair.publicKey;
    
    // Sign and send
    console.log('📝 Signing transaction...');
    transaction.sign(oldKeypair);
    
    console.log('📤 Sending transaction...');
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [oldKeypair],
      {
        commitment: 'confirmed',
        skipPreflight: false,
      }
    );
    
    console.log('\n✅ Transfer Successful!\n');
    console.log('Transaction Signature:', signature);
    console.log('Explorer:', `https://solscan.io/tx/${signature}`);
    
    // Wait for confirmation
    console.log('\n⏳ Waiting for confirmation...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check new wallet balance
    console.log('\n💰 Verifying New Wallet Balance...\n');
    const newBalance = await connection.getBalance(newKeypair.publicKey);
    const newBalanceSOL = newBalance / LAMPORTS_PER_SOL;
    
    console.log('New Wallet Balance:', newBalanceSOL.toFixed(9), 'SOL');
    
    if (newBalanceSOL > 0) {
      console.log('✅ Funds received successfully!');
    } else {
      console.log('⚠️  Balance not yet updated (may need more time)');
      console.log('   Check explorer link above to verify transaction');
    }
    
    // Check old wallet balance
    const oldBalanceAfter = await connection.getBalance(oldKeypair.publicKey);
    const oldBalanceAfterSOL = oldBalanceAfter / LAMPORTS_PER_SOL;
    console.log('\nOld Wallet Balance (after transfer):', oldBalanceAfterSOL.toFixed(9), 'SOL');
    
    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Transfer Complete!\n');
    
  } catch (error) {
    console.error('\n❌ Transfer Failed:', error.message);
    if (error.logs) {
      console.error('Transaction logs:', error.logs);
    }
    process.exit(1);
  }
}

transferFunds();
