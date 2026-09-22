/**
 * Vercel Serverless Function: Execute Trade Endpoint
 * POST /api/execute-trade
 * 
 * Executes a trade based on strategy signal
 * Supports spot swaps via Jupiter (perpetuals coming later)
 */

import crypto from 'crypto';

// services/tradeExecution.js and services/positionManager.js are NOT imported at
// module scope. They pull in the signing wallet and the perps SDKs, and loading
// that chain on a cold start was crashing this function before any of its own code
// ran - which is why an unauthenticated POST returned Vercel's plain-text
// FUNCTION_INVOCATION_FAILED instead of a JSON rejection. They are now loaded
// lazily, after the fail-closed gate passes, so a rejected request never touches
// wallet code and always gets JSON back.

/**
 * Timing-safe comparison of two strings via SHA-256 digests, so both inputs to
 * timingSafeEqual are always equal-length and no length information leaks.
 */
function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Fail-closed gate for the trade-execution route.
 *
 * Execution is OFF unless TRADE_EXECUTION_ENABLED is explicitly 'true', and even
 * then every request must present a bearer token matching TRADE_EXECUTION_API_KEY
 * (a credential separate from SCALP_CONTEXT_API_KEY). Both checks run before the
 * request body is read or logged, so an unauthenticated caller never reaches the
 * signing wallet and never has its payload written to the logs.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {{ok:true}|{ok:false,status:number,body:Object}}
 */
function checkExecutionGate(req) {
  if (process.env.TRADE_EXECUTION_ENABLED !== 'true') {
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        error: 'Trade execution disabled',
        message: 'Trade execution is disabled on this deployment.',
        timestamp: new Date().toISOString()
      }
    };
  }

  const expectedKey = process.env.TRADE_EXECUTION_API_KEY;
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/) : null;
  const providedToken = match ? match[1].trim() : null;

  if (!expectedKey || !providedToken || !safeCompare(providedToken, expectedKey)) {
    return {
      ok: false,
      status: 401,
      body: {
        success: false,
        error: 'Unauthorized',
        message: 'A valid trade-execution bearer token is required.',
        timestamp: new Date().toISOString()
      }
    };
  }

  return { ok: true };
}

export default async function handler(req, res) {
  try {
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

    // Fail-closed gate. Runs before the body is read or logged, and before any
    // wallet or execution module is loaded.
    const gate = checkExecutionGate(req);
    if (!gate.ok) {
      console.warn(`[ExecuteTrade] rejected status=${gate.status} reason=${gate.body.error}`);
      return res.status(gate.status).json(gate.body);
    }

    const [tradeExecution, positionManager] = await Promise.all([
      import('../services/tradeExecution.js'),
      import('../services/positionManager.js')
    ]);

    console.log('[ExecuteTrade] ========================================');
    console.log('[ExecuteTrade] === START REQUEST ===');
    console.log('[ExecuteTrade] Method:', req.method);
    console.log('[ExecuteTrade] URL:', req.url);
    console.log('[ExecuteTrade] Body exists:', !!req.body);
    console.log('[ExecuteTrade] Body type:', typeof req.body);
    console.log('[ExecuteTrade] Body:', JSON.stringify(req.body, null, 2));

    const { symbol, signal, tradeType = 'spot', amount, leverage = 1 } = req.body;

    console.log('[ExecuteTrade] Extracted params:');
    console.log('[ExecuteTrade]   - symbol:', symbol);
    console.log('[ExecuteTrade]   - tradeType:', tradeType);
    console.log('[ExecuteTrade]   - amount:', amount);
    console.log('[ExecuteTrade]   - leverage:', leverage);
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

    // Validate leverage for perp trades
    if (tradeType === 'perp') {
      const leverageNum = parseFloat(leverage);
      if (isNaN(leverageNum) || leverageNum < 1 || leverageNum > 200) {
        console.error('[ExecuteTrade] ❌ Invalid leverage');
        return res.status(400).json({
          error: 'Invalid leverage',
          leverage,
          message: 'Leverage must be between 1x and 200x'
        });
      }
      
      // Safety warning for high leverage
      if (leverageNum > 10) {
        console.warn('[ExecuteTrade] ⚠️  HIGH LEVERAGE WARNING:', leverageNum, 'x');
      }
      
      // Check minimum margin requirement
      const marginRequired = amount ? amount / leverageNum : 0;
      const minMargin = 0.01;
      if (marginRequired < minMargin) {
        console.error('[ExecuteTrade] ❌ Insufficient margin');
        return res.status(400).json({
          error: 'Insufficient margin',
          marginRequired: marginRequired.toFixed(2),
          minMargin,
          message: `Margin required ($${marginRequired.toFixed(2)}) is below minimum ($${minMargin})`
        });
      }
      
      console.log('[ExecuteTrade] Leverage validated:', leverageNum, 'x');
      console.log('[ExecuteTrade] Margin required:', marginRequired.toFixed(2), 'USD');
    }

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
    console.log('[ExecuteTrade]   - leverage:', leverage);
    
    const leverageNum = tradeType === 'perp' ? parseFloat(leverage) : 1;
    const result = await tradeExecution.executeTrade(signal, tradeType, amount, leverageNum);
    
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

    // Return success response (unified structure for spot and perp)
    const response = {
      success: true,
      tradeType: result.tradeType,
      direction: result.direction,
      symbol: result.symbol,
      signature: result.signature,
      explorerUrl: result.explorerUrl,
      signal: {
        entryZone: result.signal.entryZone,
        stopLoss: result.signal.stopLoss,
        targets: result.signal.targets,
      },
      timestamp: new Date().toISOString(),
    };

    // Add spot-specific fields
    if (result.tradeType === 'spot') {
      response.inputAmount = result.inputAmount;
      response.outputAmount = result.outputAmount;
      response.priceImpact = result.priceImpact;
    }

    // Add perp-specific fields
    if (result.tradeType === 'perp') {
      response.positionId = result.positionId;
      response.leverage = result.leverage;
      response.marginRequired = result.marginRequired;
      response.size = result.size;
      response.liquidationPrice = result.liquidationPrice;
      response.stopLoss = result.stopLoss;
      response.takeProfit = result.takeProfit;
      
      // Track the position
      try {
        positionManager.trackPerpPosition(
          result.positionId,
          signal,
          result.leverage,
          result
        );
        positionManager.savePositionsToStorage();
        console.log('[ExecuteTrade] ✅ Perpetual position tracked');
      } catch (trackError) {
        console.error('[ExecuteTrade] ⚠️  Failed to track position:', trackError.message);
        // Don't fail the trade if tracking fails
      }
    }

    return res.status(200).json(response);

  } catch (error) {
    // The error handler itself is wrapped, so a failure while building the error
    // response still returns JSON rather than Vercel's plain-text fallback.
    try {
      console.error('[ExecuteTrade] === ERROR ===');
      console.error('[ExecuteTrade] Error:', error.message);
      console.error('[ExecuteTrade] Stack:', error.stack);

      // Provide more user-friendly error messages
      let errorMessage = error.message || 'An unexpected error occurred';
      let statusCode = 500;

      // Check for missing environment variables (common in Vercel)
      if (error.message && (error.message.includes('SOLANA_PRIVATE_KEY') || error.message.includes('environment variable is not set'))) {
        errorMessage = 'Trading wallet not configured. Please set SOLANA_PRIVATE_KEY in Vercel environment variables.';
        statusCode = 503; // Service Unavailable
        console.error('[ExecuteTrade] ❌ MISSING ENV VAR: SOLANA_PRIVATE_KEY not set in Vercel');
      } else if (error.message && (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED'))) {
        errorMessage = 'Cannot connect to Jupiter API. Please check your internet connection and try again.';
      } else if (error.message && error.message.includes('Cannot connect to Jupiter API')) {
        errorMessage = error.message; // Already user-friendly
      } else if (error.message && error.message.includes('Failed to load wallet')) {
        errorMessage = 'Wallet configuration error. Please check SOLANA_PRIVATE_KEY in Vercel environment variables.';
        statusCode = 503;
        console.error('[ExecuteTrade] ❌ WALLET CONFIG ERROR: Check Vercel environment variables');
      }

      console.error('[ExecuteTrade] User-friendly message:', errorMessage);
      console.error('[ExecuteTrade] Status code:', statusCode);

      // Ensure we always return JSON, never plain text
      if (!res.headersSent) {
        return res.status(statusCode).json({
          success: false,
          error: statusCode === 503 ? 'Service configuration error' : 'Internal server error',
          message: errorMessage,
          timestamp: new Date().toISOString(),
          hint: statusCode === 503 ? 'This is likely a missing environment variable in Vercel. Check deployment documentation.' : undefined
        });
      }
    } catch (unexpectedError) {
      // Last resort: catch any errors in error handling itself
      console.error('[ExecuteTrade] CRITICAL: Error in error handler:', unexpectedError);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          error: 'Internal server error',
          message: 'An unexpected error occurred while processing your request',
          timestamp: new Date().toISOString()
        });
      }
    }
  }
}

