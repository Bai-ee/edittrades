/**
 * Streamable HTTP plumbing for the EditTrades MCP endpoint.
 *
 * This lives in lib/ rather than api/ on purpose. Vercel turns every file under
 * api/ into its own serverless function, and the project is at the Hobby plan's
 * 12-function ceiling, so /api/mcp is served from the api/scalp-context.js
 * function instead of getting a function of its own. That routing decision is the
 * only thing the two endpoints share: the MCP path calls buildScalpContext()
 * through services/editTradesMcp.js and never touches the REST handler's auth,
 * response shape, or status codes.
 *
 * Imports no wallet-signing, position, or trade-execution module.
 */

import crypto from 'crypto';
import {
  createEditTradesMcpServer,
  createStatelessTransport,
  TOOL_NAME
} from '../services/editTradesMcp.js';

/** Query flag set by the /api/mcp route in vercel.json. */
export const MCP_ROUTE_FLAG = '__mcp';

/**
 * Decide whether a request is for the MCP endpoint.
 *
 * The vercel.json route rewrites /api/mcp to this function with `?__mcp=1`, which
 * is an explicit signal rather than a guess about how the platform rewrites paths.
 * The pathname is accepted as a fallback so the same dispatch works under `vercel
 * dev`, a plain Node server, and the test suite.
 *
 * @param {import('http').IncomingMessage & {query?:Object}} req
 * @returns {boolean}
 */
export function isMcpRequest(req) {
  if (!req) return false;

  if (req.query && req.query[MCP_ROUTE_FLAG] === '1') return true;

  const url = typeof req.url === 'string' ? req.url : '';
  if (!url) return false;

  const path = url.split('?')[0];
  if (path === '/api/mcp' || path === '/api/mcp/') return true;

  // Query string present but req.query was not populated (plain Node server).
  return url.includes(`${MCP_ROUTE_FLAG}=1`);
}

/**
 * Serve one MCP request over stateless Streamable HTTP.
 *
 * A fresh server and transport are built per request: stateless mode is the only
 * safe choice when consecutive requests may land on different serverless instances.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {Object} [deps] - forwarded to createEditTradesMcpServer (test injection)
 * @returns {Promise<void>}
 */
export async function handleMcpRequest(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
    return res.status(200).end();
  }

  // Stateless Streamable HTTP does its work over POST. GET (server-initiated
  // SSE) and DELETE (session teardown) are session features this server does not
  // have, and the spec allows a 405 for both - but ChatGPT's connector client
  // (aiohttp) raises on any non-2xx from those probes and abandons the tool call,
  // even though its POST handshake succeeded. So GET is answered with an empty
  // event stream that closes at once (a server may end an SSE stream whenever it
  // likes), and DELETE with 204, since there is no session to tear down.
  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Connection', 'close');
    return res.end(': stateless server, no server-initiated events\n\n');
  }

  if (req.method === 'DELETE') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null
    });
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  try {
    const server = createEditTradesMcpServer({ requestId, ...deps });
    const transport = createStatelessTransport();

    // A stateless transport belongs to exactly one request, so it is torn down as
    // soon as the response finishes rather than left for the next invocation.
    res.on('close', () => {
      Promise.resolve()
        .then(() => transport.close())
        .catch(() => {})
        .then(() => server.close())
        .catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    console.log(`[EditTradesMcp] requestId=${requestId} method=POST tool=${TOOL_NAME} status=${res.statusCode} durationMs=${Date.now() - startedAt}`);
  } catch (error) {
    // Never surface a stack trace, an upstream message, or anything header-derived.
    console.error(`[EditTradesMcp] requestId=${requestId} method=POST status=500 durationMs=${Date.now() - startedAt} reason=handler_failed`);

    if (!res.headersSent) {
      return res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error', data: { requestId } },
        id: null
      });
    }
  }
}

export default { handleMcpRequest, isMcpRequest, MCP_ROUTE_FLAG };
