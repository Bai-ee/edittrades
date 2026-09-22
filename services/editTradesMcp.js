/**
 * EditTrades MCP Server
 *
 * Builds the read-only Model Context Protocol server exposed at /api/mcp. It is an
 * additive adapter beside the existing Bearer-protected GET /api/scalp-context: both
 * read the same buildScalpContext() service, and neither proxies the other.
 *
 * Exactly one tool is registered - get_scalp_context - and it is read-only. This
 * module deliberately imports nothing from the trade-execution or position layers, so
 * no execution capability can reach an MCP client even by accident.
 *
 * As of schemaVersion 1.1.0 the context carries an `account` block with tracked-wallet
 * equity. That comes from services/walletTracker.js, which reads a public address over
 * JSON-RPC and holds no signing key, so the hot-wallet module and its signing secret
 * stay unreachable from here. Equity is exposed as data only; nothing in this path can
 * move funds. (Env names are spelled out nowhere in this file on purpose - the test
 * suite greps these sources for secret-bearing identifiers.)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildScalpContext } from './scalpContext.js';

export const MCP_SERVER_NAME = 'edittrades';
export const MCP_SERVER_VERSION = '1.0.0';
export const TOOL_NAME = 'get_scalp_context';

/** Upper bound on a single context build, so a stuck upstream cannot hang a request. */
export const BUILD_TIMEOUT_MS = 25000;

export const TOOL_DESCRIPTION =
  'Fetch the latest closed-candle BTC, SOL, and ETH market context from EditTrades, ' +
  'including raw multi-timeframe indicators, structure, data quality, tracked-wallet ' +
  'account equity, and the EditTrades recommendation engine. Read-only. It does not ' +
  'place or modify trades.';

/**
 * Reject after `ms`, so a hung upstream surfaces as a tool error instead of a
 * request that never returns.
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise}
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('context build timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Condense a context payload into the short human/model-readable header that
 * accompanies the structured result. Deliberately does not restate the payload:
 * the full context travels once, as structured content.
 *
 * @param {Object} payload - buildScalpContext() output
 * @param {string} requestId
 * @returns {string}
 */
export function summarizeContext(payload, requestId) {
  const symbols = payload && payload.symbols && typeof payload.symbols === 'object'
    ? Object.keys(payload.symbols)
    : [];
  const warningCount = Array.isArray(payload && payload.warnings) ? payload.warnings.length : 0;

  return [
    `generatedAt=${(payload && payload.generatedAt) || 'unknown'}`,
    `closedThrough=${(payload && payload.closedThrough) || 'unknown'}`,
    `dataStatus=${(payload && payload.dataStatus) || 'unknown'}`,
    `warnings=${warningCount}`,
    `symbols=${symbols.length > 0 ? symbols.join(',') : 'none'}`,
    `requestId=${requestId}`
  ].join(' ');
}

/**
 * Run one tool invocation.
 *
 * Exported so the test suite can exercise the result contract without standing up
 * an HTTP server. `dataStatus: 'unavailable'` is treated as a failure so a client
 * cannot mistake an empty snapshot for a tradeable one; 'partial' and any warnings
 * are passed through untouched and stay visible in both representations.
 *
 * @param {Object} [deps]
 * @param {Function} [deps.build] - injectable buildScalpContext, for tests
 * @param {string} [deps.requestId]
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<Object>} an MCP CallToolResult
 */
export async function runGetScalpContext(deps = {}) {
  const {
    build = buildScalpContext,
    requestId = 'unknown',
    timeoutMs = BUILD_TIMEOUT_MS
  } = deps || {};

  let payload;
  try {
    payload = await withTimeout(Promise.resolve(build()), timeoutMs);
  } catch (err) {
    // Sanitized: the caller gets a stable reason, never a stack trace or an
    // upstream message that might carry a URL, header, or credential.
    console.error(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=error reason=build_failed`);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `EditTrades context unavailable: the market context could not be built. requestId=${requestId}`
      }]
    };
  }

  if (!payload || typeof payload !== 'object') {
    console.error(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=error reason=empty_payload`);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `EditTrades context unavailable: no context payload was produced. requestId=${requestId}`
      }]
    };
  }

  const warningCount = Array.isArray(payload.warnings) ? payload.warnings.length : 0;

  if (payload.dataStatus === 'unavailable') {
    console.error(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=error reason=data_unavailable dataStatus=unavailable warnings=${warningCount}`);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `EditTrades context unavailable: dataStatus=unavailable, warnings=${warningCount}. Do not trade on this run. requestId=${requestId}`
      }]
    };
  }

  console.log(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=ok dataStatus=${payload.dataStatus} warnings=${warningCount}`);

  return {
    content: [{ type: 'text', text: summarizeContext(payload, requestId) }],
    structuredContent: { ...payload, requestId }
  };
}

/**
 * Create a fresh MCP server exposing exactly one read-only tool.
 *
 * A new instance is built per request: the Streamable HTTP transport is used in
 * stateless mode, and a serverless invocation must not carry state between calls.
 *
 * @param {Object} [deps] - forwarded to runGetScalpContext (test injection)
 * @returns {McpServer}
 */
export function createEditTradesMcpServer(deps = {}) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Get EditTrades scalp context',
      description: TOOL_DESCRIPTION,
      annotations: {
        title: 'Get EditTrades scalp context',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        // The tool reads live external market data, so repeated calls legitimately
        // return different snapshots.
        openWorldHint: true
      }
    },
    async () => runGetScalpContext(deps)
  );

  return server;
}

/**
 * Create a stateless Streamable HTTP transport.
 *
 * `sessionIdGenerator: undefined` is what puts the SDK transport into stateless
 * mode - no session id is issued and none is validated, which is the only mode
 * that is safe when every request may land on a different serverless instance.
 *
 * @returns {StreamableHTTPServerTransport}
 */
export function createStatelessTransport() {
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}

export default {
  createEditTradesMcpServer,
  createStatelessTransport,
  runGetScalpContext,
  summarizeContext,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  TOOL_NAME,
  TOOL_DESCRIPTION
};
