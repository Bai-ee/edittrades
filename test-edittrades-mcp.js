/**
 * Deterministic, network-free test suite for the EditTrades MCP bridge:
 *   - services/editTradesMcp.js
 *   - lib/mcpHttp.js
 *   - the /api/mcp dispatch inside api/scalp-context.js
 *
 * Discovery and the tool round-trip run over a real Streamable HTTP transport on
 * localhost, driven by the official MCP client, so the wiring under test is the same
 * wiring ChatGPT will speak to. buildScalpContext is injected, so no market data is
 * ever fetched and no wallet or RPC code is reachable.
 *
 * Run: node test-edittrades-mcp.js
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  createEditTradesMcpServer,
  createStatelessTransport,
  runGetScalpContext,
  summarizeContext,
  TOOL_NAME,
  TOOL_DESCRIPTION,
  MCP_SERVER_NAME
} from './services/editTradesMcp.js';

import { handleMcpRequest, isMcpRequest } from './lib/mcpHttp.js';
import scalpContextHandler from './api/scalp-context.js';

// ---------------------------------------------------------------------------
// Tiny test runner (same shape as test-scalp-context.js)
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    const msg = err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n      ') : String(err);
    console.log(`      ${msg}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A context payload in the exact shape buildScalpContext() emits, carrying the
 * execution levels the engine produces so the trimming path can be asserted.
 */
function makeContext(overrides = {}) {
  return {
    schemaVersion: '1.0.0',
    generatedAt: '2026-09-22T03:22:03.391Z',
    closedThrough: '2026-09-22T03:22:00.000Z',
    sessionTimezone: 'UTC',
    dataStatus: 'complete',
    symbols: {
      BTC: {
        price: 85426.5,
        source: { provider: 'kraken', pair: 'BTCUSDT', fetchedAt: '2026-09-22T03:22:03.391Z' },
        structure: { support: [84000], resistance: [86000] },
        timeframes: {
          '1h': {
            trend: 'UPTREND',
            closedThrough: '2026-09-22T03:00:00.000Z',
            candles: [{ t: '2026-09-22T02:00:00.000Z', o: 85000, h: 85500, l: 84900, c: 85400, v: 12.5 }]
          }
        },
        strategies: {
          SCALP_1H: {
            valid: true,
            direction: 'long',
            confidence: 85,
            reason: 'fixture',
            entryZone: { min: 86000, max: 86100 },
            stopLoss: 85600,
            invalidationLevel: 85600,
            targets: [86800, 87400],
            riskReward: { tp1RR: 1.75, tp2RR: 3.25 },
            stopSource: '15m',
            entryType: 'pullback'
          }
        },
        bestSignal: 'SCALP_1H'
      },
      SOL: { price: 116.43, strategies: {}, bestSignal: null },
      ETH: { price: 2814.2, strategies: {}, bestSignal: null }
    },
    warnings: [],
    ...overrides
  };
}

/**
 * Start the MCP server on an ephemeral localhost port with an injected context
 * builder, mirroring how lib/mcpHttp.js wires the transport in production.
 * @param {Object} deps - forwarded to createEditTradesMcpServer
 * @returns {Promise<{url:string, close:()=>Promise<void>}>}
 */
async function startTestServer(deps) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(': stateless server, no server-initiated events\n\n');
      return;
    }

    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Use POST.' },
        id: null
      }));
      return;
    }

    const mcpServer = createEditTradesMcpServer(deps);
    const transport = createStatelessTransport();
    res.on('close', () => {
      Promise.resolve().then(() => transport.close()).catch(() => {});
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/api/mcp`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * Connect an MCP client to a running test server.
 * @param {string} url
 * @returns {Promise<{client:Client, close:()=>Promise<void>}>}
 */
async function connectClient(url) {
  const client = new Client({ name: 'edittrades-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** Minimal ServerResponse stand-in for exercising the HTTP surface directly. */
function makeMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    headersSent: false,
    listeners: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.ended = true; this.headersSent = true; return this; },
    end(payload) { if (payload !== undefined) this.body = payload; this.ended = true; this.headersSent = true; return this; },
    on(event, cb) { this.listeners[event] = cb; return this; }
  };
  return res;
}

// Terms that must never appear anywhere in a tool result.
const FORBIDDEN_TERMS = [
  'SOLANA_PRIVATE_KEY',
  'privateKey',
  'private_key',
  'secretKey',
  'mnemonic',
  'seedPhrase',
  'SCALP_CONTEXT_API_KEY',
  'TRADE_EXECUTION_API_KEY',
  'executeTrade',
  'execute-trade',
  'walletManager',
  'tradeExecution',
  'Authorization',
  'Bearer '
];

// ---------------------------------------------------------------------------

async function main() {
  console.log('\nEditTrades MCP bridge\n');

  // -- 1. initialize + discovery, 2. exactly one tool, 3. metadata ----------

  console.log('discovery');

  const discovery = await startTestServer({ build: async () => makeContext() });
  const { client, close: closeClient } = await connectClient(discovery.url);
  const listed = await client.listTools();

  await test('initialize succeeds and reports the EditTrades server', () => {
    const info = client.getServerVersion();
    assertEqual(info.name, MCP_SERVER_NAME, 'server name mismatch');
    assert(typeof info.version === 'string' && info.version.length > 0, 'missing server version');
  });

  await test('discovery exposes exactly one tool', () => {
    assertEqual(listed.tools.length, 1, `expected 1 tool, got ${listed.tools.length}: ${listed.tools.map((t) => t.name).join(',')}`);
  });

  await test('the one tool is get_scalp_context with the documented description', () => {
    const [tool] = listed.tools;
    assertEqual(tool.name, TOOL_NAME, 'tool name mismatch');
    assertEqual(tool.description, TOOL_DESCRIPTION, 'tool description mismatch');
  });

  await test('the tool requires no input', () => {
    const [tool] = listed.tools;
    const required = (tool.inputSchema && tool.inputSchema.required) || [];
    assertEqual(required.length, 0, `expected no required inputs, got ${JSON.stringify(required)}`);
  });

  await test('the tool is annotated read-only and non-destructive', () => {
    const [tool] = listed.tools;
    assert(tool.annotations, 'tool has no annotations');
    assertEqual(tool.annotations.readOnlyHint, true, 'readOnlyHint must be true');
    assertEqual(tool.annotations.destructiveHint, false, 'destructiveHint must be false');
  });

  await test('discovery advertises no execution, wallet, or fetch tool', () => {
    const names = listed.tools.map((t) => t.name.toLowerCase()).join(' ');
    for (const banned of ['trade', 'execute', 'wallet', 'order', 'position', 'fetch', 'balance', 'sign']) {
      assert(!names.includes(banned), `discovery exposed a "${banned}" tool`);
    }
  });

  // -- 4. successful call, 5. execution fields survive, 6. no secrets -------

  console.log('\nsuccessful call');

  const called = await client.callTool({ name: TOOL_NAME, arguments: {} });

  await test('a successful call returns structured BTC, SOL and ETH context', () => {
    assert(!called.isError, 'call reported an error');
    assert(called.structuredContent, 'no structured content returned');
    assertEqual(called.structuredContent.dataStatus, 'complete', 'dataStatus mismatch');
    const symbols = Object.keys(called.structuredContent.symbols);
    for (const s of ['BTC', 'SOL', 'ETH']) {
      assert(symbols.includes(s), `missing symbol ${s}`);
    }
  });

  await test('the compact summary carries generatedAt, closedThrough, status, warnings, symbols and request id', () => {
    const text = called.content.map((c) => c.text).join(' ');
    for (const key of ['generatedAt=', 'closedThrough=', 'dataStatus=', 'warnings=', 'symbols=', 'requestId=']) {
      assert(text.includes(key), `summary missing ${key}`);
    }
    assert(text.includes('BTC,SOL,ETH'), 'summary does not list the symbols');
  });

  await test('the summary does not duplicate the full payload', () => {
    const text = called.content.map((c) => c.text).join(' ');
    assert(text.length < 400, `summary is ${text.length} chars - it is restating the payload`);
  });

  await test('exact engine execution fields survive trimming', () => {
    const s = called.structuredContent.symbols.BTC.strategies.SCALP_1H;
    assertEqual(s.direction, 'long', 'direction lost');
    assertEqual(s.confidence, 85, 'confidence lost');
    assertEqual(s.entryZone.min, 86000, 'entryZone.min lost');
    assertEqual(s.entryZone.max, 86100, 'entryZone.max lost');
    assertEqual(s.stopLoss, 85600, 'stopLoss lost');
    assertEqual(s.targets.length, 2, 'targets lost');
    assertEqual(s.targets[0], 86800, 'tp1 lost');
    assertEqual(s.targets[1], 87400, 'tp2 lost');
    assertEqual(s.riskReward.tp1RR, 1.75, 'tp1RR lost');
    assertEqual(s.riskReward.tp2RR, 3.25, 'tp2RR lost');
    assertEqual(s.stopSource, '15m', 'stopSource lost');
  });

  await test('no private key, wallet, execution method or environment value is returned', () => {
    const serialized = JSON.stringify(called);
    for (const term of FORBIDDEN_TERMS) {
      assert(!serialized.includes(term), `tool result leaked "${term}"`);
    }
  });

  await closeClient();
  await discovery.close();

  // -- 7. unavailable fails safely -----------------------------------------

  console.log('\ndata quality');

  await test('dataStatus=unavailable is returned as a tool error', async () => {
    const result = await runGetScalpContext({
      build: async () => makeContext({ dataStatus: 'unavailable', warnings: ['BTC 1m: live data unavailable'] }),
      requestId: 'test-unavailable'
    });
    assertEqual(result.isError, true, 'unavailable data did not produce an error');
    assert(!result.structuredContent, 'an errored result must not carry context a client could trade on');
  });

  await test('an unavailable result says so in words a model cannot read as a setup', async () => {
    const result = await runGetScalpContext({
      build: async () => makeContext({ dataStatus: 'unavailable', warnings: ['x'] }),
      requestId: 'test-unavailable-text'
    });
    const text = result.content.map((c) => c.text).join(' ');
    assert(text.includes('unavailable'), 'error text does not state the data is unavailable');
    assert(text.includes('Do not trade'), 'error text does not warn against trading');
  });

  await test('partial status stays explicit in both representations', async () => {
    const result = await runGetScalpContext({
      build: async () => makeContext({ dataStatus: 'partial', warnings: ['SOL 5m: insufficient closed candles (1)'] }),
      requestId: 'test-partial'
    });
    assert(!result.isError, 'partial data must still return context');
    assertEqual(result.structuredContent.dataStatus, 'partial', 'structured dataStatus was rewritten');
    const text = result.content.map((c) => c.text).join(' ');
    assert(text.includes('dataStatus=partial'), 'summary hides the partial status');
    assert(text.includes('warnings=1'), 'summary hides the warning count');
  });

  await test('warnings are never dropped or summarized away', async () => {
    const warnings = ['BTC 3m: live data unavailable', 'ETH 1d: insufficient closed candles (0)'];
    const result = await runGetScalpContext({
      build: async () => makeContext({ dataStatus: 'partial', warnings }),
      requestId: 'test-warnings'
    });
    assertEqual(result.structuredContent.warnings.length, 2, 'warnings were dropped');
    assertEqual(result.structuredContent.warnings[0], warnings[0], 'warning text was rewritten');
    assert(result.content.map((c) => c.text).join(' ').includes('warnings=2'), 'summary undercounts warnings');
  });

  // -- 9. exceptions are sanitized -----------------------------------------

  console.log('\nfailure handling');

  await test('a thrown build error is returned sanitized, with no stack trace', async () => {
    const secret = 'sk-live-THIS-MUST-NOT-LEAK';
    const result = await runGetScalpContext({
      build: async () => { throw new Error(`upstream 401 from https://api.example.com?key=${secret}`); },
      requestId: 'test-throw'
    });
    assertEqual(result.isError, true, 'a thrown build did not produce an error result');
    const serialized = JSON.stringify(result);
    assert(!serialized.includes(secret), 'the sanitized error leaked the upstream message');
    assert(!serialized.includes('api.example.com'), 'the sanitized error leaked an upstream URL');
    assert(!serialized.includes('at '), 'the sanitized error looks like it carries a stack trace');
  });

  await test('a build that never resolves is bounded by the timeout', async () => {
    const result = await runGetScalpContext({
      build: () => new Promise(() => {}),
      requestId: 'test-timeout',
      timeoutMs: 50
    });
    assertEqual(result.isError, true, 'a hung build did not time out into an error');
  });

  await test('an empty payload fails closed', async () => {
    const result = await runGetScalpContext({ build: async () => null, requestId: 'test-empty' });
    assertEqual(result.isError, true, 'a null payload did not produce an error');
  });

  // -- 10. unsupported HTTP methods ----------------------------------------

  console.log('\nHTTP surface');

  const mcpReq = (method) => ({ method, url: '/api/mcp', query: { __mcp: '1' }, headers: {}, body: undefined, on() {} });

  for (const method of ['PUT', 'PATCH']) {
    await test(`${method} /api/mcp is rejected with 405`, async () => {
      const res = makeMockRes();
      await handleMcpRequest(mcpReq(method), res);
      assertEqual(res.statusCode, 405, `${method} was not rejected`);
    });
  }

  await test('GET /api/mcp answers 200 with an empty, closed event stream', async () => {
    // ChatGPT's connector client opens this stream after the POST handshake and
    // raises on a 405, which is what surfaced as aiohttp ClientResponseError.
    const res = makeMockRes();
    await handleMcpRequest(mcpReq('GET'), res);
    assertEqual(res.statusCode, 200, 'GET must not be rejected');
    assertEqual(res.getHeader('Content-Type'), 'text/event-stream', 'GET must answer as an event stream');
    assert(res.ended, 'the GET stream must be closed immediately on a stateless server');
    assert(typeof res.body === 'string' && res.body.startsWith(':'), 'the stream body must be an SSE comment only, never a JSON-RPC message');
  });

  await test('DELETE /api/mcp answers 204: nothing to tear down', async () => {
    const res = makeMockRes();
    await handleMcpRequest(mcpReq('DELETE'), res);
    assertEqual(res.statusCode, 204, 'DELETE must be a no-op success');
    assert(res.ended, 'DELETE must end the response');
  });

  await test('OPTIONS /api/mcp preflight succeeds', async () => {
    const res = makeMockRes();
    await handleMcpRequest(mcpReq('OPTIONS'), res);
    assertEqual(res.statusCode, 200, 'preflight failed');
  });

  await test('every response sets Cache-Control: no-store', async () => {
    const res = makeMockRes();
    await handleMcpRequest(mcpReq('GET'), res);
    assertEqual(res.getHeader('Cache-Control'), 'no-store', 'missing no-store');
  });

  // -- the shared function dispatches the two endpoints apart --------------

  console.log('\nroute dispatch');

  await test('the __mcp route flag selects the MCP endpoint', () => {
    assertEqual(isMcpRequest({ url: '/api/scalp-context?__mcp=1', query: { __mcp: '1' } }), true, 'flagged request not routed to MCP');
    assertEqual(isMcpRequest({ url: '/api/mcp', query: {} }), true, 'the /api/mcp path is not routed to MCP');
  });

  await test('an ordinary scalp-context request is never routed to MCP', () => {
    assertEqual(isMcpRequest({ url: '/api/scalp-context', query: {} }), false, 'a REST request was hijacked by the MCP dispatcher');
    assertEqual(isMcpRequest({ url: '/api/scalp-context', query: { symbol: 'BTC' } }), false, 'a REST request with a query was hijacked');
    assertEqual(isMcpRequest({}), false, 'an empty request was routed to MCP');
  });

  await test('the REST endpoint keeps its 401 while sharing the function', async () => {
    // No bearer token and no MCP flag: the request must fall through to the REST
    // handler and be rejected there, exactly as before the two endpoints merged.
    const res = makeMockRes();
    await scalpContextHandler({ method: 'GET', url: '/api/scalp-context', query: {}, headers: {}, on() {} }, res);
    assertEqual(res.statusCode, 401, 'the REST path lost its 401 on an unauthenticated request');
  });

  await test('the REST endpoint keeps rejecting non-GET methods', async () => {
    const res = makeMockRes();
    await scalpContextHandler({ method: 'POST', url: '/api/scalp-context', query: {}, headers: {}, on() {} }, res);
    assertEqual(res.statusCode, 405, 'the REST path lost its 405');
  });

  await test('an MCP request reaching the shared function bypasses REST auth', async () => {
    // The MCP path must not be answered with the REST handler's 401.
    const res = makeMockRes();
    await scalpContextHandler(mcpReq('GET'), res);
    assertEqual(res.statusCode, 200, 'the MCP path was answered by the REST handler instead');
    assertEqual(res.getHeader('Content-Type'), 'text/event-stream', 'the MCP GET was not answered by the MCP dispatcher');
  });

  // -- 11. the MCP route cannot reach execution ----------------------------

  console.log('\nisolation');

  const mcpSources = {
    'lib/mcpHttp.js': readFileSync(new URL('./lib/mcpHttp.js', import.meta.url), 'utf8'),
    'services/editTradesMcp.js': readFileSync(new URL('./services/editTradesMcp.js', import.meta.url), 'utf8')
  };

  await test('the MCP route imports no wallet, execution or position module', () => {
    const banned = ['tradeExecution', 'walletManager', 'positionManager', 'jupiterSwap', 'jupiterPerps', 'driftPerps', 'mangoPerps', 'perpsProvider'];
    for (const [file, src] of Object.entries(mcpSources)) {
      for (const mod of banned) {
        assert(!new RegExp(`^\\s*import[^\\n]*${mod}`, 'm').test(src), `${file} imports ${mod}`);
      }
    }
  });

  await test('the MCP route never reads a private key or credential from the environment', () => {
    // Asserts on actual process.env access rather than on the name appearing in
    // prose, so a comment documenting that a key is NOT used does not fail here.
    for (const [file, src] of Object.entries(mcpSources)) {
      for (const env of ['SOLANA_PRIVATE_KEY', 'SOLANA_RPC_URL', 'JUPITER_API_KEY', 'TRADE_EXECUTION_API_KEY', 'SCALP_CONTEXT_API_KEY']) {
        for (const pattern of [`process.env.${env}`, `process.env['${env}']`, `process.env["${env}"]`]) {
          assert(!src.includes(pattern), `${file} reads ${env}`);
        }
      }
    }
  });

  await test('walletTracker, reachable via the context, holds no signing capability', () => {
    // scalpContext imports walletTracker, so the MCP route reaches it transitively.
    // The read-only invariant only holds if that module cannot sign or execute.
    const src = readFileSync(new URL('./services/walletTracker.js', import.meta.url), 'utf8');
    assert(!src.includes('SOLANA_PRIVATE_KEY'), 'walletTracker references the signing key env');
    for (const mod of ['walletManager', 'tradeExecution', 'positionManager', '@solana/web3.js']) {
      assert(!new RegExp(`^\\s*import[^\\n]*${mod}`, 'm').test(src), `walletTracker imports ${mod}`);
    }
  });

  await test('a wallet snapshot never carries the RPC url', async () => {
    // A paid RPC endpoint embeds its API key in the url, so the url must stay out of
    // the payload that travels to a third-party model.
    const { getAccountSnapshot } = await import('./services/walletTracker.js');
    const sentinel = 'https://rpc.example.invalid/?api-key=SENTINEL_SECRET';

    const snapshot = await getAccountSnapshot({
      address: 'So11111111111111111111111111111111111111112',
      rpcUrl: sentinel,
      solPrice: 200,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 1e9 } })
      })
    });

    assert(!JSON.stringify(snapshot).includes('SENTINEL_SECRET'), 'snapshot leaked the RPC url');
    assert(!JSON.stringify(snapshot).includes('rpc.example.invalid'), 'snapshot leaked the RPC host');
  });

  await test('this suite itself never imports trade execution', () => {
    const self = readFileSync(new URL('./test-edittrades-mcp.js', import.meta.url), 'utf8');
    for (const mod of ['services/tradeExecution', 'services/walletManager', 'api/execute-trade']) {
      assert(!new RegExp(`^\\s*import[^\\n]*${mod}`, 'm').test(self), `the test suite imports ${mod}`);
    }
  });

  await test('summarizeContext leaks nothing from an odd payload', () => {
    const text = summarizeContext({ dataStatus: 'complete', symbols: null, warnings: null }, 'rid');
    assert(typeof text === 'string' && text.includes('requestId=rid'), 'summary broke on a sparse payload');
    assert(text.includes('symbols=none'), 'summary mishandled a missing symbols map');
  });

  // -- 12. payload controls (phase 5): symbols / include / compact ---------

  console.log('\npayload controls');

  const controls = await startTestServer({ build: async () => makeContext() });
  const { client: controlsClient, close: closeControlsClient } = await connectClient(controls.url);

  await test('the tool advertises symbols, include and compact as optional arguments', async () => {
    const { tools } = await controlsClient.listTools();
    const [tool] = tools;
    assertEqual(tools.length, 1, 'expected exactly one tool');
    const props = tool.inputSchema && tool.inputSchema.properties;
    assert(props && props.symbols && props.include && props.compact, 'tool input schema is missing symbols/include/compact');
    const required = (tool.inputSchema && tool.inputSchema.required) || [];
    assertEqual(required.length, 0, `expected symbols/include/compact to all be optional, got required=${JSON.stringify(required)}`);
    assertEqual(tool.annotations.readOnlyHint, true, 'gaining arguments must not lose the read-only annotation');
  });

  await test('{} (no arguments) returns a payload identical to an unfiltered build', async () => {
    const bare = await controlsClient.callTool({ name: TOOL_NAME, arguments: {} });
    assert(!bare.isError, 'a bare call must not error');
    const unfiltered = makeContext();
    assertEqual(
      JSON.stringify(bare.structuredContent.symbols),
      JSON.stringify(unfiltered.symbols),
      'symbols must be identical to an unfiltered build with the same injected context'
    );
    assertEqual(JSON.stringify(bare.structuredContent.warnings), JSON.stringify(unfiltered.warnings), 'warnings must be unaffected by an empty args object');
  });

  await test('symbols: ["BTC"] returns only BTC', async () => {
    const res = await controlsClient.callTool({ name: TOOL_NAME, arguments: { symbols: ['BTC'] } });
    assert(!res.isError, 'a symbols-filtered call must not error');
    assertEqual(Object.keys(res.structuredContent.symbols).join(','), 'BTC', 'expected only BTC in the response');
  });

  await test('an unknown symbol is ignored, not an error, and named in a warning', async () => {
    const res = await controlsClient.callTool({ name: TOOL_NAME, arguments: { symbols: ['XRP'] } });
    assert(!res.isError, 'an unknown symbol must not error the call');
    assertEqual(Object.keys(res.structuredContent.symbols).sort().join(','), 'BTC,ETH,SOL', 'an all-unknown symbols filter must fall back to the full set, not collapse to nothing');
    assert(res.structuredContent.warnings.some((w) => w.includes('XRP')), 'expected a warning naming the ignored symbol');
  });

  await test('include: ["strategies"] drops timeframes but keeps strategies and core fields', async () => {
    const res = await controlsClient.callTool({ name: TOOL_NAME, arguments: { include: ['strategies'] } });
    assert(!res.isError, 'an include-filtered call must not error');
    const btc = res.structuredContent.symbols.BTC;
    assert(!('timeframes' in btc), 'timeframes must be dropped when include excludes it');
    assert(btc.strategies && btc.strategies.SCALP_1H, 'strategies must survive include=["strategies"]');
    assert('price' in btc && 'source' in btc && 'bestSignal' in btc, 'core identity fields are not gated by include');
  });

  await test('an unknown include value is ignored, not an error, and named in a warning', async () => {
    const res = await controlsClient.callTool({ name: TOOL_NAME, arguments: { include: ['bogus'] } });
    assert(!res.isError, 'an unknown include value must not error the call');
    assert('timeframes' in res.structuredContent.symbols.BTC, 'an all-unknown include filter must fall back to the full payload');
    assert(res.structuredContent.warnings.some((w) => w.includes('bogus')), 'expected a warning naming the ignored include value');
  });

  await test('compact: true drops candles only, indicators survive', async () => {
    const res = await controlsClient.callTool({ name: TOOL_NAME, arguments: { compact: true } });
    assert(!res.isError, 'a compact call must not error');
    const tf = res.structuredContent.symbols.BTC.timeframes['1h'];
    assertEqual(tf.candles.length, 0, 'compact must drop the candles array');
    assertEqual(tf.trend, 'UPTREND', 'compact must not touch a non-candle indicator field');
    assertEqual(tf.closedThrough, '2026-09-22T03:00:00.000Z', 'compact must not touch closedThrough');
  });

  await closeControlsClient();
  await controls.close();

  // -- 13. confirmation chart (phase 8b) ------------------------------------

  console.log('\nconfirmation chart');

  // makeContext plus a BTC 1m window for the chart to draw. Records every build call's
  // arguments so the no-chart path can be shown to call build() exactly as before.
  const buildCalls = [];
  function chartContext() {
    const ctx = makeContext();
    ctx.symbols.BTC.timeframes['1m'] = {
      ema21: 85400,
      ema200: 85300,
      closedThrough: '2026-09-22T03:21:00.000Z',
      candles: Array.from({ length: 30 }, (_, i) => ({
        t: new Date(Date.UTC(2026, 8, 22, 2, 52 + i)).toISOString(),
        o: 85400 + (i % 3) * 5, h: 85420 + (i % 3) * 5, l: 85390, c: 85405 + (i % 4) * 4, v: 1
      }))
    };
    ctx.symbols.BTC.candidateSetups = [{ timeframe: '1m', type: 'flag', direction: 'long', state: 'forming', flagHigh: 85425, flagLow: 85392, breakoutLevel: 85425, invalidation: 85392 }];
    return ctx;
  }
  const chartBuild = async (...callArgs) => {
    buildCalls.push(callArgs);
    const opts = callArgs[0];
    if (opts && opts.chart) opts.chart.onSeries({ ema21: Array(30).fill(85400), ema200: Array(30).fill(85300) });
    return chartContext();
  };
  const charts = await startTestServer({ build: chartBuild });
  const { client: chartClient, close: closeChartClient } = await connectClient(charts.url);
  const imageBlocks = (res) => (res.content || []).filter((c) => c.type === 'image');

  await test('the tool advertises chart as an optional string and stays single and read-only', async () => {
    const { tools } = await chartClient.listTools();
    assertEqual(tools.length, 1, 'expected exactly one tool');
    const props = tools[0].inputSchema.properties;
    assert(props.chart && props.chart.type === 'string', 'chart must be advertised as a string');
    assertEqual(((tools[0].inputSchema.required) || []).length, 0, 'chart must be optional');
    assertEqual(tools[0].annotations.readOnlyHint, true, 'read-only annotation lost');
    assertEqual(tools[0].annotations.destructiveHint, false, 'destructive hint changed');
  });

  await test('no chart argument: no image block, build() called with no arguments, result unchanged', async () => {
    buildCalls.length = 0;
    const res = await chartClient.callTool({ name: TOOL_NAME, arguments: {} });
    assert(!res.isError, 'a bare call must not error');
    assertEqual(imageBlocks(res).length, 0, 'no image without chart');
    assertEqual(res.content.length, 1, 'exactly the one summary text block');
    assertEqual(buildCalls.length, 1, 'one build');
    assertEqual(buildCalls[0].length, 0, 'build() must be called with no arguments, as before phase 8b');
    // Byte-identical to the pre-8b handler: same summary text, same structured payload.
    const direct = await runGetScalpContext({ build: async () => chartContext(), requestId: res.structuredContent.requestId });
    assertEqual(JSON.stringify(res.content), JSON.stringify(direct.content), 'content differs from a chartless run');
    assertEqual(JSON.stringify(res.structuredContent), JSON.stringify(direct.structuredContent), 'structuredContent differs from a chartless run');
    assert(!res.content[0].text.includes('chart='), 'summary must not mention a chart');
  });

  await test('include ["bias"] builds with includeBias; include without bias keeps build() argument-free (phase 9b)', async () => {
    buildCalls.length = 0;
    await chartClient.callTool({ name: TOOL_NAME, arguments: { include: ['strategies', 'bias'] } });
    assertEqual(JSON.stringify(buildCalls[0]), JSON.stringify([{ includeBias: true }]), 'build args with bias');
    buildCalls.length = 0;
    await chartClient.callTool({ name: TOOL_NAME, arguments: { include: ['strategies'] } });
    assertEqual(buildCalls[0].length, 0, 'no bias requested → build()');
    buildCalls.length = 0;
    await chartClient.callTool({ name: TOOL_NAME, arguments: { include: ['bias'], chart: 'BTC:1m' } });
    assertEqual(buildCalls[0][0].includeBias, true, 'bias + chart');
    assertEqual(buildCalls[0][0].chart.symbol, 'BTC', 'chart kept');
  });

  await test('chart "BTC:1m": exactly one PNG image block for that symbol/timeframe', async () => {
    buildCalls.length = 0;
    const res = await chartClient.callTool({ name: TOOL_NAME, arguments: { chart: 'BTC:1m' } });
    assert(!res.isError, `chart call errored: ${JSON.stringify(res.content)}`);
    const images = imageBlocks(res);
    assertEqual(images.length, 1, 'exactly one image block');
    assertEqual(images[0].mimeType, 'image/png', 'mime type');
    assertEqual(Buffer.from(images[0].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG magic bytes');
    assertEqual(res.content[0].type, 'text', 'summary text first');
    assert(res.content[0].text.endsWith('chart=BTC:1m'), 'summary names the chart');
    assert(res.structuredContent && res.structuredContent.symbols.BTC, 'structuredContent still carried');
    const opts = buildCalls[0][0];
    assertEqual(`${opts.chart.symbol}:${opts.chart.timeframe}`, 'BTC:1m', 'build asked for the named chart only');
  });

  for (const [label, chart] of [
    ['two charts in one string', 'BTC:1m,SOL:5m'],
    ['two chart args', ['BTC:1m', 'SOL:5m']],
    ['unknown symbol', 'XRP:1m'],
    ['unknown timeframe', 'BTC:2h'],
    ['malformed value', 'BTC']
  ]) {
    await test(`chart rejected with isError: ${label}`, async () => {
      buildCalls.length = 0;
      const res = await chartClient.callTool({ name: TOOL_NAME, arguments: { chart } });
      assertEqual(res.isError, true, 'expected isError');
      assertEqual(imageBlocks(res).length, 0, 'no image on a rejected chart');
      assert(res.content[0].type === 'text' && res.content[0].text.length > 0, 'error must carry text');
      assertEqual(buildCalls.length, 0, 'a rejected chart must not trigger a build');
    });
  }

  await test('chart for a timeframe the build has no candles for is an error, not a blank image', async () => {
    const res = await chartClient.callTool({ name: TOOL_NAME, arguments: { chart: 'SOL:4h' } });
    assertEqual(res.isError, true, 'expected isError');
    assertEqual(imageBlocks(res).length, 0, 'no image');
    assert(res.content[0].text.includes('No closed candles'), 'error names the missing data');
  });

  await closeChartClient();
  await charts.close();

  // ---------------------------------------------------------------------

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) {
    for (const f of failures) console.log(`FAILED: ${f.name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
