/**
 * Jupiter Swap API Integration
 * Handles spot token swaps via Jupiter Aggregator API v6
 * Free tier: 60 requests/minute, no API key required
 */

import axios from 'axios';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { getConnection, getWallet } from './walletManager.js';
import 'dotenv/config';

// Jupiter API endpoints (updated 2024)
// Using lite-api.jup.ag with v1 endpoints (quote-api.jup.ag is deprecated)
const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1';
const JUPITER_SWAP_API = 'https://lite-api.jup.ag/swap/v1';

/**
 * Get swap quote from Jupiter API
 * @param {string} inputMint - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {number} amountIn - Amount in smallest unit (lamports/wei)
 * @param {number} slippageBps - Slippage tolerance in basis points (default: 50 = 0.5%)
 * @returns {Promise<Object>} Quote object with route and output amount
 */
export async function getSwapQuote(inputMint, outputMint, amountIn, slippageBps = 50) {
  const url = `${JUPITER_QUOTE_API}/quote`;
  
  try {
    console.log('[JupiterSwap] Getting quote...');
    console.log('[JupiterSwap] URL:', url);
    console.log('[JupiterSwap] Input:', inputMint, 'Amount:', amountIn);
    console.log('[JupiterSwap] Output:', outputMint);
    console.log('[JupiterSwap] Slippage:', slippageBps, 'bps');

    const params = {
      inputMint,
      outputMint,
      amount: amountIn.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: 'false', // Allow multi-hop routes for better prices
      asLegacyTransaction: 'false', // Use versioned transactions
    };

    // Add API key if available (for higher rate limits)
    const headers = {};
    if (process.env.JUPITER_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.JUPITER_API_KEY}`;
    }

    console.log('[JupiterSwap] Making request to:', url);
    console.log('[JupiterSwap] Params:', JSON.stringify(params, null, 2));
    
    const response = await axios.get(url, { params, headers });

    if (!response.data || !response.data.outAmount) {
      throw new Error('Invalid quote response from Jupiter API');
    }

    console.log('[JupiterSwap] ✅ Quote received');
    console.log('[JupiterSwap] Output amount:', response.data.outAmount);
    console.log('[JupiterSwap] Price impact:', response.data.priceImpactPct || 'N/A', '%');
    console.log('[JupiterSwap] Route:', response.data.routePlan ? 'Multi-hop' : 'Direct');

    return response.data;
  } catch (error) {
    console.error('[JupiterSwap] ❌ Error getting quote:', error.message);
    console.error('[JupiterSwap] Error code:', error.code);
    console.error('[JupiterSwap] Error type:', error.constructor.name);
    console.error('[JupiterSwap] URL attempted:', url);
    
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      console.error('[JupiterSwap] ❌ Network/DNS error - cannot reach Jupiter API');
      throw new Error(`Cannot connect to Jupiter API. Please check your internet connection. Error: ${error.message}`);
    }
    
    if (error.response) {
      console.error('[JupiterSwap] Response status:', error.response.status);
      console.error('[JupiterSwap] Response data:', error.response.data);
      throw new Error(`Jupiter API error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
    }
    
    throw new Error(`Failed to get swap quote: ${error.message}`);
  }
}

/**
 * Build swap transaction from quote
 * @param {Object} quote - Quote object from getSwapQuote
 * @param {string} userPublicKey - User's Solana public key (base58)
 * @returns {Promise<VersionedTransaction>} Serialized transaction ready to sign
 */
export async function buildSwapTransaction(quote, userPublicKey) {
  try {
    console.log('[JupiterSwap] Building swap transaction...');
    console.log('[JupiterSwap] User public key:', userPublicKey);

    const url = `${JUPITER_SWAP_API}/swap`;
    const body = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true, // Automatically wrap/unwrap SOL
      dynamicComputeUnitLimit: true, // Let Jupiter set compute units
      prioritizationFeeLamports: 'auto', // Auto-calculate priority fee
    };

    // Add API key if available
    const headers = {
      'Content-Type': 'application/json',
    };
    if (process.env.JUPITER_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.JUPITER_API_KEY}`;
    }

    const response = await axios.post(url, body, { headers });

    if (!response.data || !response.data.swapTransaction) {
      throw new Error('Invalid swap transaction response from Jupiter API');
    }

    // Decode base64 transaction
    const swapTransactionBuf = Buffer.from(response.data.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Note: If deserialize fails, try alternative method
    // const transaction = VersionedTransaction.deserialize(new Uint8Array(swapTransactionBuf));

    console.log('[JupiterSwap] ✅ Transaction built');
    console.log('[JupiterSwap] Transaction size:', swapTransactionBuf.length, 'bytes');

    return transaction;
  } catch (error) {
    console.error('[JupiterSwap] ❌ Error building transaction:', error.message);
    if (error.response) {
      console.error('[JupiterSwap] Response status:', error.response.status);
      console.error('[JupiterSwap] Response data:', error.response.data);
    }
    throw new Error(`Failed to build swap transaction: ${error.message}`);
  }
}

/**
 * Sign and send swap transaction
 * @param {VersionedTransaction} transaction - Transaction from buildSwapTransaction
 * @returns {Promise<string>} Transaction signature
 */
export async function executeSwap(transaction) {
  try {
    console.log('[JupiterSwap] Signing transaction...');

    const wallet = getWallet();
    const connection = getConnection();

    // Sign transaction
    transaction.sign([wallet]);

    console.log('[JupiterSwap] ✅ Transaction signed');
    console.log('[JupiterSwap] Sending transaction...');

    // Send transaction
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false, // Run preflight checks
      maxRetries: 3,
    });

    console.log('[JupiterSwap] ✅ Transaction sent');
    console.log('[JupiterSwap] Signature:', signature);
    console.log('[JupiterSwap] Explorer:', `https://solscan.io/tx/${signature}`);

    // Wait for confirmation
    console.log('[JupiterSwap] Waiting for confirmation...');
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');

    if (confirmation.value.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
    }

    console.log('[JupiterSwap] ✅ Transaction confirmed');
    console.log('[JupiterSwap] Slot:', confirmation.value.slot);

    return signature;
  } catch (error) {
    console.error('[JupiterSwap] ❌ Error executing swap:', error.message);
    throw new Error(`Failed to execute swap: ${error.message}`);
  }
}

/**
 * Complete swap flow: quote → build → execute
 * @param {string} inputMint - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {number} amountIn - Amount in smallest unit
 * @param {number} slippageBps - Slippage tolerance in basis points
 * @returns {Promise<Object>} Execution result with signature and output amount
 */
export async function swapTokens(inputMint, outputMint, amountIn, slippageBps = 50) {
  try {
    console.log('[JupiterSwap] ===== Starting Swap =====');
    console.log('[JupiterSwap] Input:', inputMint);
    console.log('[JupiterSwap] Output:', outputMint);
    console.log('[JupiterSwap] Amount:', amountIn);
    console.log('[JupiterSwap] API URL:', JUPITER_QUOTE_API);

    // Step 1: Get quote
    console.log('[JupiterSwap] Step 1: Getting quote from Jupiter API...');
    const quote = await getSwapQuote(inputMint, outputMint, amountIn, slippageBps);

    // Step 2: Build transaction
    const wallet = getWallet();
    const userPublicKey = wallet.publicKey.toBase58();
    const transaction = await buildSwapTransaction(quote, userPublicKey);

    // Step 3: Execute transaction
    const signature = await executeSwap(transaction);

    console.log('[JupiterSwap] ===== Swap Complete =====');
    console.log('[JupiterSwap] Transaction signature:', signature);

    return {
      success: true,
      signature,
      inputAmount: amountIn,
      outputAmount: quote.outAmount,
      priceImpact: quote.priceImpactPct || null,
      explorerUrl: `https://solscan.io/tx/${signature}`,
    };
  } catch (error) {
    console.error('[JupiterSwap] ===== Swap Failed =====');
    console.error('[JupiterSwap] Error:', error.message);
    throw error;
  }
}

/**
 * Get transaction status
 * @param {string} signature - Transaction signature
 * @returns {Promise<Object>} Transaction status
 */
export async function getTransactionStatus(signature) {
  try {
    const connection = getConnection();
    const status = await connection.getSignatureStatus(signature);

    return {
      signature,
      confirmed: status?.value?.confirmationStatus || null,
      err: status?.value?.err || null,
      slot: status?.context?.slot || null,
    };
  } catch (error) {
    console.error('[JupiterSwap] Error getting transaction status:', error.message);
    throw error;
  }
}

