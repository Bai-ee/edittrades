#!/usr/bin/env node

/**
 * Generate Solana Wallet and Extract Private Key
 * 
 * This script generates a new Solana keypair and outputs:
 * - Public key (wallet address)
 * - Private key in base58 format (for .env file)
 * 
 * Usage: node scripts/generate-wallet.js
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

console.log('🔐 Generating Solana Wallet...\n');
console.log('='.repeat(60));

// Generate new keypair
const keypair = Keypair.generate();

// Get public key (wallet address)
const publicKey = keypair.publicKey.toBase58();

// Get private key (secret key)
// The secret key is 64 bytes: [32-byte seed, 32-byte public key]
// We only need the first 32 bytes (seed) for Keypair.fromSeed()
const secretKey = keypair.secretKey;
const seed = secretKey.slice(0, 32); // First 32 bytes

// Encode seed to base58 (this is what we store in .env)
const privateKeyBase58 = bs58.encode(seed);

console.log('\n✅ Wallet Generated Successfully!\n');
console.log('📋 Copy these values to your .env file:\n');
console.log('─'.repeat(60));
console.log('SOLANA_PRIVATE_KEY=' + privateKeyBase58);
console.log('─'.repeat(60));

console.log('\n📝 Wallet Details:\n');
console.log('Public Key (Wallet Address):', publicKey);
console.log('Private Key (Base58):', privateKeyBase58);
console.log('Private Key Length:', privateKeyBase58.length, 'characters');

console.log('\n⚠️  IMPORTANT SECURITY NOTES:\n');
console.log('1. Keep your private key SECRET - never share it!');
console.log('2. This is a NEW wallet with 0 SOL balance');
console.log('3. Fund this wallet before using it for trading');
console.log('4. Start with small amounts for testing');
console.log('5. Never commit .env file to git');

console.log('\n💰 Next Steps:\n');
console.log('1. Copy SOLANA_PRIVATE_KEY to your .env file');
console.log('2. Fund the wallet with SOL (recommended: 0.1-0.5 SOL for testing)');
console.log('3. Send SOL to address:', publicKey);
console.log('4. Verify balance: node -e "import(\'./services/walletManager.js\').then(m => m.verifyWallet())"');

console.log('\n' + '='.repeat(60));
console.log('\n✅ Done! Your wallet is ready to use.\n');

