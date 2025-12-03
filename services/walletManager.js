/**
 * Wallet Manager Service
 * Manages Solana wallet/keypair for trading operations
 * Development only - uses hot wallet from environment variables
 */

import { Keypair, Connection, clusterApiUrl } from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

let wallet = null;
let connection = null;

/**
 * Get or create wallet keypair from environment variable
 * @returns {Keypair} Solana keypair
 */
export function getWallet() {
  if (wallet) {
    return wallet;
  }

  const privateKeyBase58 = process.env.SOLANA_PRIVATE_KEY;

  if (!privateKeyBase58) {
    throw new Error('SOLANA_PRIVATE_KEY environment variable is not set. Please set it in your .env file.');
  }

  try {
    // Decode base58 private key to Uint8Array
    const privateKeyBytes = bs58.decode(privateKeyBase58);

    // Validate key length (should be 64 bytes for full keypair or 32 bytes for seed)
    if (privateKeyBytes.length !== 64 && privateKeyBytes.length !== 32) {
      throw new Error(`Invalid private key length: ${privateKeyBytes.length}. Expected 32 or 64 bytes.`);
    }

    // If 32 bytes, it's a seed - create keypair from seed
    // If 64 bytes, it's a full keypair - use first 32 bytes as seed
    const seed = privateKeyBytes.length === 64 ? privateKeyBytes.slice(0, 32) : privateKeyBytes;
    
    wallet = Keypair.fromSeed(seed);
    
    console.log('[WalletManager] Wallet loaded successfully');
    console.log('[WalletManager] Wallet address:', wallet.publicKey.toBase58());
    
    // Safety warning for mainnet
    const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');
    if (rpcUrl.includes('mainnet')) {
      console.warn('[WalletManager] ⚠️  WARNING: Using MAINNET with real funds!');
      console.warn('[WalletManager] ⚠️  Ensure this is intentional and wallet has minimal funds for testing.');
    }
    
    return wallet;
  } catch (error) {
    console.error('[WalletManager] ERROR loading wallet:', error.message);
    throw new Error(`Failed to load wallet: ${error.message}`);
  }
}

/**
 * Get wallet public address
 * @returns {string} Base58 encoded public key
 */
export function getWalletAddress() {
  const wallet = getWallet();
  return wallet.publicKey.toBase58();
}

/**
 * Get or create Solana connection
 * @returns {Connection} Solana RPC connection
 */
export function getConnection() {
  if (connection) {
    return connection;
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');
  
  console.log('[WalletManager] Connecting to Solana RPC:', rpcUrl);
  
  connection = new Connection(rpcUrl, 'confirmed');
  
  return connection;
}

/**
 * Check wallet balance
 * @returns {Promise<number>} Balance in SOL
 */
export async function getBalance() {
  try {
    const wallet = getWallet();
    const connection = getConnection();
    
    const balance = await connection.getBalance(wallet.publicKey);
    const solBalance = balance / 1e9; // Convert lamports to SOL
    
    console.log('[WalletManager] Wallet balance:', solBalance, 'SOL');
    
    return solBalance;
  } catch (error) {
    console.error('[WalletManager] ERROR getting balance:', error.message);
    throw error;
  }
}

/**
 * Verify wallet is properly configured
 * @returns {Promise<boolean>} True if wallet is ready
 */
export async function verifyWallet() {
  try {
    const wallet = getWallet();
    const address = wallet.publicKey.toBase58();
    const balance = await getBalance();
    
    console.log('[WalletManager] ✅ Wallet verified');
    console.log('[WalletManager] Address:', address);
    console.log('[WalletManager] Balance:', balance, 'SOL');
    
    if (balance < 0.01) {
      console.warn('[WalletManager] ⚠️  Low balance! Ensure wallet has enough SOL for transaction fees.');
    }
    
    return true;
  } catch (error) {
    console.error('[WalletManager] ❌ Wallet verification failed:', error.message);
    return false;
  }
}

