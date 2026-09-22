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
import { handleMcpRequest, isMcpRequest } from '../lib/mcpHttp.js';
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
  // /api/mcp is routed into this function because the project is at the Vercel
  // Hobby 12-function ceiling. It is dispatched before any REST logic runs and
  // shares nothing with it: no auth, status codes, or response shape below this
  // line is reached or altered on the MCP path.
  if (isMcpRequest(req)) {
    return handleMcpRequest(req, res);
  }

  res.setHeader('Cache-Control', 'no-store');

  // Unmatched /api/* paths are routed here by vercel.json so they are LOGGED.
  // Before this, a wrong path fell through to the static route and produced an
  // unlogged 404, which made client-side failures impossible to diagnose.
  if (req.query && req.query.__unknown === '1') {
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 80) : null;
    console.log(`[ScalpContext] unmatched-api-path method=${req.method} url=${String(req.url).slice(0, 120)} ua=${JSON.stringify(ua)}`);
    return res.status(404).json({ error: 'Not found' });
  }

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
      // Permanent, non-secret shape of the failed credential: never the header
      // value, the token, or the expected key. Enough to tell "no header" from
      // "wrong token" from "wrong scheme" in one log line.
      const authShape = {
        present: typeof authHeader === 'string' && authHeader.length > 0,
        scheme: typeof authHeader === 'string' ? (authHeader.split(' ')[0] || null) : null,
        tokenLength: providedToken ? providedToken.length : 0,
        keyConfigured: Boolean(expectedKey),
        ua: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 60) : null
      };
      console.log(`[ScalpContext] requestId=${requestId} status=401 durationMs=${Date.now() - startedAt} symbols=0 warnings=0 auth=${JSON.stringify(authShape)}`);
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
