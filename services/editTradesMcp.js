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

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildScalpContext, filterPayload, wantsBias, wantsModel } from './scalpContext.js';
import { parseChartArg, renderContextChart, ChartRequestError } from '../lib/chartRender.js';

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
 * Tool input, all optional. `{}` (or omitting arguments entirely) returns today's full
 * payload unchanged - see filterPayload in services/scalpContext.js. Deliberately plain
 * string arrays rather than z.enum: an unknown symbol or include value must be ignored
 * with a warning, never rejected at the schema-validation layer before the handler runs.
 */
export const TOOL_INPUT_SCHEMA = {
  symbols: z.array(z.string()).optional()
    .describe('Limit the response to these symbols (BTC, SOL, ETH). Unknown values are ignored. Omit for all three.'),
  include: z.array(z.string()).optional()
    .describe('Limit each symbol to these sections (timeframes, strategies, candidates, geometry, account, trace, config, bias). bias (biasMatrix, alignment, decisionInputs) is opt-in: only returned when listed. Unknown values are ignored. Omit for the full payload.'),
  compact: z.boolean().optional()
    .describe('When true, omit candle arrays and keep only the computed indicator summaries.'),
  chart: z.string().optional()
    .describe('One confirmation chart as SYMBOL:TIMEFRAME, e.g. "BTC:1m". Adds one PNG image beside the context. One chart per call; omit for no image.')
};

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
 * @param {Object} [deps.args] - validated tool arguments ({ symbols?, include?, compact?, chart? }),
 *   applied via filterPayload after the build. {} (the default) is a no-op. `chart`
 *   (phase 8b) adds one image block; without it the result is unchanged.
 * @returns {Promise<Object>} an MCP CallToolResult
 */
export async function runGetScalpContext(deps = {}) {
  const {
    build = buildScalpContext,
    requestId = 'unknown',
    timeoutMs = BUILD_TIMEOUT_MS,
    args = {}
  } = deps || {};

  // Confirmation chart (phase 8b): validated before the build so a bad request costs
  // nothing. Absent -> build() is called exactly as before and no image is added.
  let chartRequest = null;
  try {
    chartRequest = parseChartArg((args || {}).chart);
  } catch (err) {
    if (!(err instanceof ChartRequestError)) throw err;
    console.error(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=error reason=chart_${err.code}`);
    return { isError: true, content: [{ type: 'text', text: `EditTrades chart rejected: ${err.message} requestId=${requestId}` }] };
  }
  let chartSeries;
  // Bias/model objects are opt-in: build() is called exactly as before unless include
  // lists them.
  const buildOpts = {
    ...(wantsBias((args || {}).include) ? { includeBias: true } : {}),
    ...(wantsModel((args || {}).include) ? { includeModel: true } : {})
  };
  const optBuild = Object.keys(buildOpts).length > 0 ? buildOpts : null;
  const buildCall = chartRequest
    ? () => build({ ...buildOpts, chart: { ...chartRequest, onSeries: (s) => { chartSeries = s; } } })
    : () => (optBuild ? build(optBuild) : build());

  let payload;
  try {
    payload = await withTimeout(Promise.resolve(buildCall()), timeoutMs);
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

  // Filtering (phase 5) happens after the build, never inside it: {} is a no-op, so
  // dataStatus/warnings below always reflect the same build a bare call would see.
  const filtered = filterPayload(payload, args || {});
  const warningCount = Array.isArray(filtered.warnings) ? filtered.warnings.length : 0;

  if (filtered.dataStatus === 'unavailable') {
    console.error(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=error reason=data_unavailable dataStatus=unavailable warnings=${warningCount}`);
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `EditTrades context unavailable: dataStatus=unavailable, warnings=${warningCount}. Do not trade on this run. requestId=${requestId}`
      }]
    };
  }

  if (chartRequest) {
    // Rendered from the unfiltered build, so symbols/include/compact cannot strip the
    // candles or geometry the chart draws.
    let chart;
    try {
      chart = await renderContextChart(payload, chartRequest, chartSeries);
    } catch (err) {
      const reason = err instanceof ChartRequestError ? err.message : 'the chart could not be rendered.';
      console.error(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=error reason=chart_${err instanceof ChartRequestError ? err.code : 'render_failed'}`);
      return { isError: true, content: [{ type: 'text', text: `EditTrades chart unavailable: ${reason} requestId=${requestId}` }] };
    }
    const chartName = `${chartRequest.symbol}:${chartRequest.timeframe}`;
    console.log(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=ok dataStatus=${filtered.dataStatus} warnings=${warningCount} chart=${chartName} chartBytes=${chart.bytes} chartMs=${chart.durationMs}`);
    return {
      content: [
        { type: 'text', text: `${summarizeContext(filtered, requestId)} chart=${chartName}` },
        { type: 'image', data: chart.png.toString('base64'), mimeType: 'image/png' }
      ],
      structuredContent: { ...filtered, requestId }
    };
  }

  console.log(`[EditTradesMcp] requestId=${requestId} tool=${TOOL_NAME} status=ok dataStatus=${filtered.dataStatus} warnings=${warningCount}`);

  return {
    content: [{ type: 'text', text: summarizeContext(filtered, requestId) }],
    structuredContent: { ...filtered, requestId }
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
      inputSchema: TOOL_INPUT_SCHEMA,
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
    async (args) => runGetScalpContext({ ...deps, args })
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
  TOOL_DESCRIPTION,
  TOOL_INPUT_SCHEMA
};
