#!/usr/bin/env node

/**
 * Generate Solana Wallet with BIP39 Seed Phrase
 * 
 * This script generates a new Solana wallet using BIP39 mnemonic (12-word phrase)
 * Compatible with Phantom, Solflare, and other standard wallets
 * 
 * Usage: node scripts/generate-wallet-with-phrase.js
 */

import { Keypair } from '@solana/web3.js';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import bs58 from 'bs58';

console.log('🔐 Generating Solana Wallet with Seed Phrase...\n');
console.log('='.repeat(60));

// Generate 12-word mnemonic phrase (128 bits of entropy)
const mnemonic = bip39.generateMnemonic(128); // 12 words

console.log('\n✅ Wallet Generated Successfully!\n');

// Derive seed from mnemonic
const seed = await bip39.mnemonicToSeed(mnemonic);

// Derive keypair using Solana's derivation path
// Solana uses: m/44'/501'/0'/0' (same as Ethereum but with coin type 501)
const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
const keypair = Keypair.fromSeed(derivedSeed);

// Get public key (wallet address)
const publicKey = keypair.publicKey.toBase58();

// Extract private key seed (first 32 bytes)
const privateKeySeed = keypair.secretKey.slice(0, 32);
const privateKeyBase58 = bs58.encode(privateKeySeed);

console.log('📋 IMPORTANT: Save this information securely!\n');
console.log('─'.repeat(60));
console.log('🔑 SEED PHRASE (12 words):');
console.log('─'.repeat(60));
console.log(mnemonic);
console.log('─'.repeat(60));

console.log('\n📝 Wallet Details:\n');
console.log('Public Key (Wallet Address):');
console.log('  ', publicKey);
console.log('\nPrivate Key (Base58):');
console.log('  ', privateKeyBase58);

console.log('\n📋 Copy to .env file:\n');
console.log('─'.repeat(60));
console.log('SOLANA_PRIVATE_KEY=' + privateKeyBase58);
console.log('─'.repeat(60));

console.log('\n⚠️  CRITICAL SECURITY NOTES:\n');
console.log('1. ⚠️  WRITE DOWN YOUR SEED PHRASE IMMEDIATELY');
console.log('2. ⚠️  Store it in a secure location (password manager, safe)');
console.log('3. ⚠️  NEVER share your seed phrase with anyone');
console.log('4. ⚠️  This seed phrase can restore your entire wallet');
console.log('5. ⚠️  If you lose the seed phrase, you lose access forever');

console.log('\n💡 How to Use This Wallet:\n');
console.log('1. Copy the seed phrase above (12 words)');
console.log('2. Copy SOLANA_PRIVATE_KEY to your .env file');
console.log('3. Fund the wallet with SOL and USDC');
console.log('4. You can also import this seed phrase into Phantom/Solflare');

console.log('\n🔄 To Import into Phantom/Solflare:');
console.log('1. Open wallet extension');
console.log('2. Choose "Import existing wallet"');
console.log('3. Enter the 12-word seed phrase');
console.log('4. Wallet will be restored with same address');

console.log('\n💰 Next Steps:\n');
console.log('1. Save the seed phrase securely');
console.log('2. Add SOLANA_PRIVATE_KEY to .env file');
console.log('3. Fund wallet: Send SOL/USDC to', publicKey);
console.log('4. Verify: node scripts/check-balances.js');

console.log('\n' + '='.repeat(60));
console.log('\n✅ Wallet with seed phrase ready!\n');
console.log('⚠️  REMEMBER: Save your seed phrase NOW before closing this window!\n');

