/**
 * Vercel Serverless Function: Execute Trade Endpoint
 * POST /api/execute-trade
 * 
 * Executes a trade based on strategy signal
 * Supports spot swaps via Jupiter (perpetuals coming later)
 */

import crypto from 'crypto';
import * as tradeExecution from '../services/tradeExecution.js';

/**
 * ===========================================================================
 * THIS ENDPOINT SIGNS REAL MAINNET TRANSACTIONS
 * ===========================================================================
 *
 * It had no authentication of any kind: no key, no session, no origin check,
 * with `Access-Control-Allow-Origin: *`. The only gate was
 * `tradeExecution.validateSignal(signal)`, whose first test is `signal.valid`
 * — a boolean the caller supplies in the request body. The endpoint validated
 * attacker-controlled data against itself and then spent the operator's wallet.
 * A single unauthenticated curl with `{"signal":{"valid":true,...}}` executed a
 * swap, and `MAX_TRADE_SIZE_USD` caps one request, not a loop of them.
 *
 * Three controls now stand in front of execution, all default-closed:
 *
 *   1. TRADING_ENABLED must be explicitly 'true'. Absent means off, so a
 *      deployment that merely has a wallet configured is not armed.
 *   2. TRADE_EXECUTION_SECRET must match the x-trading-secret header, compared
 *      in constant time. No secret configured means no execution.
 *   3. A per-window trade counter and cumulative notional cap, so the
 *      per-request size limit cannot be defeated by repetition.
 *
 * MAX_TRADES_PER_HOUR and AUTO_EXECUTION_ENABLED were documented in
 * docs/SOLANA_WALLET_SETUP.md but appeared in zero lines of code. Documented
 * controls that do not exist are worse than none: they read as reassurance.
 * TRADING_ENABLED is the implementation of that kill switch.
 *
 * NOTE ON SCOPE: a shared secret is a bearer token, so it authenticates the
 * caller but does not bind a signal to a real strategy run. The server still
 * trusts the client's `signal` object. Closing that properly means re-running
 * the strategy server-side for `symbol` and executing only the signal the
 * server computed, or issuing signed signal IDs. That is a larger change and
 * is called out in the audit handoff rather than half-done here.
 */

/** Constant-time compare that does not leak length via early return. */
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Rate/notional ledger.
 *
 * In-memory, so on Vercel it is per-lambda-instance and several concurrent
 * instances each hold their own count — it raises the cost of a drain attempt
 * rather than bounding it absolutely. It is a backstop behind the secret, not
 * a substitute for one. A durable counter needs a datastore this deployment
 * does not currently have; recorded as a known limitation.
 */
const executionLedger = { windowStart: Date.now(), count: 0, notional: 0 };
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(amountUsd) {
  const now = Date.now();
  if (now - executionLedger.windowStart > RATE_WINDOW_MS) {
    executionLedger.windowStart = now;
    executionLedger.count = 0;
    executionLedger.notional = 0;
  }

  const maxTrades = parseInt(process.env.MAX_TRADES_PER_HOUR || '3', 10);
  const maxNotional = parseFloat(process.env.MAX_NOTIONAL_PER_HOUR_USD || '1000');

  if (executionLedger.count >= maxTrades) {
    return { allowed: false, reason: `Hourly trade limit reached (${maxTrades})` };
  }
  if (executionLedger.notional + amountUsd > maxNotional) {
    return {
      allowed: false,
      reason: `Hourly notional limit reached ($${maxNotional}); this request would bring the window to $${(executionLedger.notional + amountUsd).toFixed(2)}`
    };
  }
  return { allowed: true };
}

export default async function handler(req, res) {
  // Not `*`. This endpoint spends money; it is not a public read API, and a
  // wildcard lets any page on the internet invoke it from a visitor's browser.
  const allowedOrigin = process.env.TRADING_ALLOWED_ORIGIN || '';
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-trading-secret');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // --- Kill switch ---------------------------------------------------------
  if (process.env.TRADING_ENABLED !== 'true') {
    console.warn('[ExecuteTrade] Rejected: TRADING_ENABLED is not "true"');
    return res.status(503).json({
      error: 'Trade execution is disabled',
      message:
        'Set TRADING_ENABLED=true and TRADE_EXECUTION_SECRET to arm this endpoint. It is off by default.'
    });
  }

  // --- Authentication ------------------------------------------------------
  const expectedSecret = process.env.TRADE_EXECUTION_SECRET;
  if (!expectedSecret) {
    console.error('[ExecuteTrade] Rejected: TRADE_EXECUTION_SECRET is not configured');
    return res.status(503).json({
      error: 'Trade execution is not configured',
      message: 'TRADE_EXECUTION_SECRET must be set before trades can be executed.'
    });
  }
  if (!secretMatches(req.headers['x-trading-secret'], expectedSecret)) {
    console.warn('[ExecuteTrade] Rejected: bad or missing x-trading-secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[ExecuteTrade] === START REQUEST ===');
    // Headers are NOT logged. The dump here previously included every request
    // header, which now carries the execution secret.
    console.log('[ExecuteTrade] Body keys:', req.body ? Object.keys(req.body).join(',') : 'none');

    const { symbol, signal, tradeType = 'spot', amount } = req.body || {};

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

    // --- Amount validation -------------------------------------------------
    // `if (amount && amount > max)` let a NEGATIVE amount through (it is
    // truthy but not greater than the cap) and treated a missing amount as
    // acceptable, whereupon tradeExecution defaulted it to $1. An amount that
    // decides how much money moves must be an explicit number in range.
    const maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE_USD || '1000');
    const amountUsd = Number(amount);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({
        error: 'Invalid amount',
        message: 'amount must be a positive number of USD.'
      });
    }
    if (amountUsd > maxTradeSize) {
      return res.status(400).json({
        error: 'Trade size exceeds maximum',
        amount: amountUsd,
        maxTradeSize,
        message: `Trade size ($${amountUsd}) exceeds maximum allowed ($${maxTradeSize})`
      });
    }

    // --- Rate and cumulative notional limits -------------------------------
    const rate = checkRateLimit(amountUsd);
    if (!rate.allowed) {
      console.warn(`[ExecuteTrade] Rejected by rate limit: ${rate.reason}`);
      return res.status(429).json({ error: 'Rate limit exceeded', message: rate.reason });
    }
    executionLedger.count += 1;
    executionLedger.notional += amountUsd;

    // Execute trade
    console.log('[ExecuteTrade] ========================================');
    console.log('[ExecuteTrade] Calling tradeExecution.executeTrade()...');
    console.log('[ExecuteTrade] Parameters:');
    console.log('[ExecuteTrade]   - tradeType:', tradeType, 'amount:', amountUsd);
    
    const result = await tradeExecution.executeTrade(signal, tradeType, amountUsd);
    
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

