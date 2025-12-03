/**
 * Vercel Serverless Function: Execute Trade Endpoint
 * POST /api/execute-trade
 * 
 * Executes a trade based on strategy signal
 * Supports spot swaps via Jupiter (perpetuals coming later)
 */

import * as tradeExecution from '../services/tradeExecution.js';

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    console.log('[ExecuteTrade] ========================================');
    console.log('[ExecuteTrade] === START REQUEST ===');
    console.log('[ExecuteTrade] Method:', req.method);
    console.log('[ExecuteTrade] URL:', req.url);
    console.log('[ExecuteTrade] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[ExecuteTrade] Body exists:', !!req.body);
    console.log('[ExecuteTrade] Body type:', typeof req.body);
    console.log('[ExecuteTrade] Body:', JSON.stringify(req.body, null, 2));

    const { symbol, signal, tradeType = 'spot', amount } = req.body;

    console.log('[ExecuteTrade] Extracted params:');
    console.log('[ExecuteTrade]   - symbol:', symbol);
    console.log('[ExecuteTrade]   - tradeType:', tradeType);
    console.log('[ExecuteTrade]   - amount:', amount);
    console.log('[ExecuteTrade]   - signal exists:', !!signal);
    console.log('[ExecuteTrade]   - signal type:', typeof signal);

    // Validate required fields
    if (!signal) {
      console.error('[ExecuteTrade] ❌ Missing signal in request body');
      return res.status(400).json({ 
        error: 'Missing required field: signal',
        message: 'Signal object is required'
      });
    }

    console.log('[ExecuteTrade] Signal received:');
    console.log('[ExecuteTrade]   - valid:', signal.valid);
    console.log('[ExecuteTrade]   - direction:', signal.direction);
    console.log('[ExecuteTrade]   - symbol:', signal.symbol);
    console.log('[ExecuteTrade]   - entryZone:', signal.entryZone);
    console.log('[ExecuteTrade]   - stopLoss:', signal.stopLoss);
    console.log('[ExecuteTrade]   - targets:', signal.targets);

    // Add symbol to signal if not present
    if (!signal.symbol && symbol) {
      console.log('[ExecuteTrade] Adding symbol to signal:', symbol);
      signal.symbol = symbol;
    }

    // Validate signal
    console.log('[ExecuteTrade] Validating signal...');
    const validation = tradeExecution.validateSignal(signal);
    console.log('[ExecuteTrade] Validation result:', validation);
    
    if (!validation.valid) {
      console.error('[ExecuteTrade] ❌ Signal validation failed');
      console.error('[ExecuteTrade] Validation errors:', validation.errors);
      return res.status(400).json({
        error: 'Invalid signal',
        validationErrors: validation.errors,
        signal: signal
      });
    }

    console.log('[ExecuteTrade] ✅ Signal validated successfully');
    console.log('[ExecuteTrade] Trade type:', tradeType);
    console.log('[ExecuteTrade] Amount:', amount);

    // Check safety limits
    const maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE_USD || '1000');
    console.log('[ExecuteTrade] Max trade size:', maxTradeSize);
    if (amount && amount > maxTradeSize) {
      console.error('[ExecuteTrade] ❌ Trade size exceeds maximum');
      return res.status(400).json({
        error: 'Trade size exceeds maximum',
        amount,
        maxTradeSize,
        message: `Trade size ($${amount}) exceeds maximum allowed ($${maxTradeSize})`
      });
    }

    // Execute trade
    console.log('[ExecuteTrade] ========================================');
    console.log('[ExecuteTrade] Calling tradeExecution.executeTrade()...');
    console.log('[ExecuteTrade] Parameters:');
    console.log('[ExecuteTrade]   - signal:', JSON.stringify(signal, null, 2));
    console.log('[ExecuteTrade]   - tradeType:', tradeType);
    console.log('[ExecuteTrade]   - amount:', amount);
    
    const result = await tradeExecution.executeTrade(signal, tradeType, amount);
    
    console.log('[ExecuteTrade] ========================================');
    console.log('[ExecuteTrade] Trade execution returned:');
    console.log('[ExecuteTrade]   - success:', result.success);
    console.log('[ExecuteTrade]   - result keys:', Object.keys(result));

    if (!result.success) {
      return res.status(500).json({
        error: 'Trade execution failed',
        message: result.error,
        signal: signal
      });
    }

    console.log('[ExecuteTrade] === SUCCESS ===');
    console.log('[ExecuteTrade] Transaction signature:', result.signature);

    // Return success response
    return res.status(200).json({
      success: true,
      tradeType: result.tradeType,
      direction: result.direction,
      symbol: result.symbol,
      signature: result.signature,
      explorerUrl: result.explorerUrl,
      inputAmount: result.inputAmount,
      outputAmount: result.outputAmount,
      priceImpact: result.priceImpact,
      signal: {
        entryZone: result.signal.entryZone,
        stopLoss: result.signal.stopLoss,
        targets: result.signal.targets,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[ExecuteTrade] === ERROR ===');
    console.error('[ExecuteTrade] Error:', error.message);
    console.error('[ExecuteTrade] Stack:', error.stack);

    // Provide more user-friendly error messages
    let errorMessage = error.message;
    let statusCode = 500;
    
    // Check for missing environment variables (common in Vercel)
    if (error.message.includes('SOLANA_PRIVATE_KEY') || error.message.includes('environment variable is not set')) {
      errorMessage = 'Trading wallet not configured. Please set SOLANA_PRIVATE_KEY in Vercel environment variables.';
      statusCode = 503; // Service Unavailable
      console.error('[ExecuteTrade] ❌ MISSING ENV VAR: SOLANA_PRIVATE_KEY not set in Vercel');
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      errorMessage = 'Cannot connect to Jupiter API. Please check your internet connection and try again.';
    } else if (error.message.includes('Cannot connect to Jupiter API')) {
      errorMessage = error.message; // Already user-friendly
    } else if (error.message.includes('Failed to load wallet')) {
      errorMessage = 'Wallet configuration error. Please check SOLANA_PRIVATE_KEY in Vercel environment variables.';
      statusCode = 503;
      console.error('[ExecuteTrade] ❌ WALLET CONFIG ERROR: Check Vercel environment variables');
    }
    
    console.error('[ExecuteTrade] === ERROR ===');
    console.error('[ExecuteTrade] Error:', error.message);
    console.error('[ExecuteTrade] Stack:', error.stack);
    console.error('[ExecuteTrade] User-friendly message:', errorMessage);
    console.error('[ExecuteTrade] Status code:', statusCode);

    return res.status(statusCode).json({
      error: statusCode === 503 ? 'Service configuration error' : 'Internal server error',
      message: errorMessage,
      timestamp: new Date().toISOString(),
      hint: statusCode === 503 ? 'This is likely a missing environment variable in Vercel. Check deployment documentation.' : undefined
    });
  }
}

