/**
 * Trade Execution Service
 * Orchestrates trade execution based on strategy signals
 * Currently supports spot swaps via Jupiter
 * Perpetuals support will be added after swap testing
 */

import * as jupiterSwap from './jupiterSwap.js';
import * as tokenMapping from './tokenMapping.js';
import { getWallet } from './walletManager.js';
import { getConnection } from './walletManager.js';

/**
 * Execute a trade based on strategy signal
 * @param {Object} signal - Strategy signal object
 * @param {string} tradeType - 'spot' or 'perp' (currently only 'spot' supported)
 * @param {number} amountUSD - Trade amount in USD (optional, defaults to signal-based calculation)
 * @returns {Promise<Object>} Execution result
 */
export async function executeTrade(signal, tradeType = 'spot', amountUSD = null) {
  try {
    console.log('[TradeExecution] ========================================');
    console.log('[TradeExecution] ===== Starting Trade Execution =====');
    console.log('[TradeExecution] Input parameters:');
    console.log('[TradeExecution]   - signal type:', typeof signal);
    console.log('[TradeExecution]   - signal:', JSON.stringify(signal, null, 2));
    console.log('[TradeExecution]   - tradeType:', tradeType);
    console.log('[TradeExecution]   - amountUSD:', amountUSD);

    // Validate signal
    if (!signal || !signal.valid) {
      throw new Error('Invalid signal: signal must be valid');
    }

    if (!signal.direction || (signal.direction !== 'long' && signal.direction !== 'short')) {
      throw new Error('Invalid signal: direction must be "long" or "short"');
    }

    if (!signal.entryZone || !signal.entryZone.min || !signal.entryZone.max) {
      throw new Error('Invalid signal: entryZone is required');
    }

    // Currently only spot swaps are supported
    if (tradeType !== 'spot') {
      throw new Error(`Trade type "${tradeType}" not yet supported. Only "spot" swaps are available.`);
    }

    // Get symbol from signal (assumes signal has symbol field)
    const symbol = signal.symbol || signal.pair || 'SOLUSDT';
    console.log('[TradeExecution] ✅ Symbol extracted:', symbol);

    // Determine input and output tokens based on direction
    // For long: Buy token with SOL/USDC
    // For short: Sell token for SOL/USDC
    const baseToken = symbol.replace('USDT', '').replace('USD', '');
    console.log('[TradeExecution] Base token:', baseToken);
    
    console.log('[TradeExecution] Looking up token addresses...');
    const baseTokenAddress = tokenMapping.getTokenAddress(symbol);
    const usdcAddress = tokenMapping.getTokenAddress('USDC');
    
    console.log('[TradeExecution] Token addresses:');
    console.log('[TradeExecution]   - baseTokenAddress:', baseTokenAddress);
    console.log('[TradeExecution]   - usdcAddress:', usdcAddress);

    if (!baseTokenAddress) {
      console.error('[TradeExecution] ❌ Token address not found for symbol:', symbol);
      throw new Error(`Token address not found for symbol: ${symbol}`);
    }
    
    if (!usdcAddress) {
      console.error('[TradeExecution] ❌ USDC address not found');
      throw new Error('USDC token address not found');
    }
    
    console.log('[TradeExecution] ✅ Token addresses found');

    // Calculate trade amount
    console.log('[TradeExecution] Calculating trade amount...');
    const entryMid = (signal.entryZone.min + signal.entryZone.max) / 2;
    console.log('[TradeExecution] Entry zone mid:', entryMid);
    
    let amountIn;

    if (amountUSD) {
      // Use provided USD amount
      amountIn = amountUSD;
      console.log('[TradeExecution] Using provided amount:', amountIn, 'USD');
    } else {
      // Calculate from signal (use a conservative amount for MVP)
      // Default to $1 USD equivalent (changed from $100)
      amountIn = 1;
      console.log('[TradeExecution] Using default amount: $1 USD');
    }
    
    console.log('[TradeExecution] Final amountIn:', amountIn, 'USD');

    // Convert USD amount to token amount
    // Use USDC as base currency (more stable than SOL for trading)
    // User can fund wallet with USDC and trade with it
    // Note: Still need SOL for transaction fees (~0.000005 SOL per tx)
    
    let inputMint, outputMint, amountInSmallestUnit;

    if (signal.direction === 'long') {
      // Long: Buy base token with USDC (more stable than SOL)
      inputMint = usdcAddress;
      outputMint = baseTokenAddress;
      
      // Convert USD amount directly to USDC (1:1 ratio)
      // USDC has 6 decimals, so $100 = 100 * 10^6 = 100,000,000 smallest units
      amountInSmallestUnit = tokenMapping.toTokenAmount(amountIn, 'USDC');
      
      console.log('[TradeExecution] LONG: Buying', baseToken, 'with', amountIn, 'USDC');
    } else {
      // Short/Sell: Sell base token for USDC
      // For sells, we have the token and want to convert it back to USDC
      inputMint = baseTokenAddress;
      outputMint = usdcAddress;
      
      // For sells, we need to calculate how many tokens to sell based on USD amount
      // We'll get a quote first to determine the token amount, then use that
      // For now, we'll estimate based on current price from entryZone
      const estimatedPrice = (signal.entryZone.min + signal.entryZone.max) / 2;
      const tokenAmount = amountIn / estimatedPrice;
      
      // Convert token amount to smallest units
      amountInSmallestUnit = tokenMapping.toTokenAmount(tokenAmount, symbol);
      
      console.log('[TradeExecution] SHORT/SELL: Selling', tokenAmount, baseToken, 'for', amountIn, 'USDC');
      console.log('[TradeExecution] Estimated price:', estimatedPrice);
      console.log('[TradeExecution] Token amount (smallest units):', amountInSmallestUnit);
    }

    console.log('[TradeExecution] ========================================');
    console.log('[TradeExecution] Swap parameters:');
    console.log('[TradeExecution]   - Input mint:', inputMint);
    console.log('[TradeExecution]   - Output mint:', outputMint);
    console.log('[TradeExecution]   - Amount (smallest unit):', amountInSmallestUnit);
    console.log('[TradeExecution]   - Amount (human readable):', amountIn, 'USD');

    // Execute swap
    const slippageBps = 100; // 1% slippage tolerance for MVP
    console.log('[TradeExecution] Slippage tolerance:', slippageBps, 'bps (1%)');
    console.log('[TradeExecution] ========================================');
    console.log('[TradeExecution] Calling jupiterSwap.swapTokens()...');
    
    let result;
    try {
      result = await jupiterSwap.swapTokens(
        inputMint,
        outputMint,
        amountInSmallestUnit,
        slippageBps
      );
      
      console.log('[TradeExecution] ✅ Swap completed successfully');
      console.log('[TradeExecution] Swap result keys:', Object.keys(result));
      console.log('[TradeExecution] Swap result:', JSON.stringify(result, null, 2));
    } catch (swapError) {
      console.error('[TradeExecution] ❌ Swap failed:');
      console.error('[TradeExecution] Error message:', swapError.message);
      console.error('[TradeExecution] Error stack:', swapError.stack);
      throw swapError;
    }

    console.log('[TradeExecution] ===== Trade Execution Complete =====');
    console.log('[TradeExecution] Result:', JSON.stringify(result, null, 2));

    return {
      success: true,
      tradeType: 'spot',
      direction: signal.direction,
      symbol,
      signature: result.signature,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      priceImpact: result.priceImpact,
      explorerUrl: result.explorerUrl,
      signal: {
        entryZone: signal.entryZone,
        stopLoss: signal.stopLoss,
        targets: signal.targets,
      },
    };
  } catch (error) {
    console.error('[TradeExecution] ===== Trade Execution Failed =====');
    console.error('[TradeExecution] Error:', error.message);
    console.error('[TradeExecution] Stack:', error.stack);
    
    return {
      success: false,
      error: error.message,
      tradeType,
      signal,
    };
  }
}

/**
 * Execute stop loss
 * @param {Object} signal - Original signal
 * @param {number} entryPrice - Actual entry price
 * @returns {Promise<Object>} Execution result
 */
export async function executeStopLoss(signal, entryPrice) {
  try {
    console.log('[TradeExecution] Executing stop loss...');
    console.log('[TradeExecution] Entry price:', entryPrice);
    console.log('[TradeExecution] Stop loss:', signal.stopLoss);

    // For stop loss, we need to sell the token we bought
    // This requires knowing what token we hold
    const symbol = signal.symbol || 'SOLUSDT';
    const baseTokenAddress = tokenMapping.getTokenAddress(symbol);
    const solAddress = tokenMapping.getTokenAddress('SOL');

    if (!baseTokenAddress) {
      throw new Error(`Token address not found for symbol: ${symbol}`);
    }

    // Get current position size (would need to track this)
    // For MVP, this is simplified
    throw new Error('Stop loss execution requires position tracking. Not yet implemented.');
  } catch (error) {
    console.error('[TradeExecution] Error executing stop loss:', error.message);
    throw error;
  }
}

/**
 * Execute take profit
 * @param {Object} signal - Original signal
 * @param {number} entryPrice - Actual entry price
 * @param {number} targetIndex - Which target (0 for TP1, 1 for TP2)
 * @returns {Promise<Object>} Execution result
 */
export async function executeTakeProfit(signal, entryPrice, targetIndex = 0) {
  try {
    console.log('[TradeExecution] Executing take profit...');
    console.log('[TradeExecution] Entry price:', entryPrice);
    console.log('[TradeExecution] Target index:', targetIndex);
    console.log('[TradeExecution] Target price:', signal.targets?.[targetIndex]);

    // Similar to stop loss - requires position tracking
    throw new Error('Take profit execution requires position tracking. Not yet implemented.');
  } catch (error) {
    console.error('[TradeExecution] Error executing take profit:', error.message);
    throw error;
  }
}

/**
 * Validate trade signal before execution
 * @param {Object} signal - Strategy signal
 * @returns {Object} Validation result
 */
export function validateSignal(signal) {
  const errors = [];

  if (!signal) {
    errors.push('Signal is required');
    return { valid: false, errors };
  }

  if (!signal.valid) {
    errors.push('Signal must be valid');
  }

  if (!signal.direction || (signal.direction !== 'long' && signal.direction !== 'short')) {
    errors.push('Signal direction must be "long" or "short"');
  }

  if (!signal.entryZone || !signal.entryZone.min || !signal.entryZone.max) {
    errors.push('Signal must have valid entryZone with min and max');
  }

  if (!signal.stopLoss) {
    errors.push('Signal must have stopLoss');
  }

  if (!signal.targets || !Array.isArray(signal.targets) || signal.targets.length === 0) {
    errors.push('Signal must have at least one target');
  }

  const symbol = signal.symbol || signal.pair;
  if (!symbol) {
    errors.push('Signal must have symbol or pair');
  } else if (!tokenMapping.isSymbolSupported(symbol)) {
    errors.push(`Symbol ${symbol} is not supported`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

