/**
 * Vercel Serverless Function: Scalp Context Endpoint
 * GET /api/scalp-context
 *
 * Returns a compact, scalp-oriented market context snapshot built by
 * services/scalpContext.js. Requires a bearer token matching
 * SCALP_CONTEXT_API_KEY. Responds 503 when upstream market data is
 * unavailable, and never echoes secrets, stack traces, or trade-execution
 * details.
 */

import { buildScalpContext } from '../services/scalpContext.js';
import crypto from 'crypto';

/**
 * Timing-safe comparison of two strings via SHA-256 digests, so both
 * inputs to timingSafeEqual are always equal-length and no length
 * information leaks from the comparison.
 */
function safeCompare(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const expectedKey = process.env.SCALP_CONTEXT_API_KEY;
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+(.+)$/) : null;
    const providedToken = match ? match[1].trim() : null;

    if (!expectedKey || !providedToken || !safeCompare(providedToken, expectedKey)) {
      console.log(`[ScalpContext] requestId=${requestId} status=401 durationMs=${Date.now() - startedAt} symbols=0 warnings=0`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const payload = await buildScalpContext();
    const warningsCount = Array.isArray(payload?.warnings) ? payload.warnings.length : 0;
    const symbolsCount = Array.isArray(payload?.symbols)
      ? payload.symbols.length
      : (payload?.symbols ? 1 : 0);

    if (payload?.dataStatus === 'unavailable') {
      console.log(`[ScalpContext] requestId=${requestId} status=503 durationMs=${Date.now() - startedAt} symbols=${symbolsCount} warnings=${warningsCount}`);
      return res.status(503).json({
        error: 'Market data unavailable',
        requestId,
        warnings: payload?.warnings
      });
    }

    console.log(`[ScalpContext] requestId=${requestId} status=200 durationMs=${Date.now() - startedAt} symbols=${symbolsCount} warnings=${warningsCount}`);
    return res.status(200).json({
      ...payload,
      requestId
    });
  } catch (error) {
    console.log(`[ScalpContext] requestId=${requestId} status=500 durationMs=${Date.now() - startedAt} symbols=0 warnings=0`);
    return res.status(500).json({ error: 'Internal error', requestId });
  }
}
