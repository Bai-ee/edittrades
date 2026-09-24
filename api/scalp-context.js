/**
 * Vercel Serverless Function: Scalp Context Endpoint
 * GET /api/scalp-context
 *
 * Returns a compact, scalp-oriented market context snapshot built by
 * services/scalpContext.js. Requires a bearer token matching
 * SCALP_CONTEXT_API_KEY. Responds 503 when upstream market data is
 * unavailable, and never echoes secrets, stack traces, or trade-execution
 * details. `?chart=SYMBOL:TIMEFRAME` (phase 8b) returns one image/png instead of
 * JSON; it is read after auth.
 *
 * Side effect (T3, docs/PLAN_SERVED_CALLS.md): a JSON 200 first records the unfiltered
 * payload's calls to Vercel Blob (lib/servedCalls.js), awaited with a 1500 ms cap. It
 * never changes the status, headers or body; TRACK_SERVED_CALLS=false turns it off.
 */

import { buildScalpContext, filterPayload, wantsBias, wantsModel } from '../services/scalpContext.js';
import { handleMcpRequest, isMcpRequest } from '../lib/mcpHttp.js';
import { parseChartArg, renderContextChart, ChartRequestError } from '../lib/chartRender.js';
import { recordServedCalls } from '../lib/servedCalls.js';
import crypto from 'crypto';

/**
 * Parse a comma-separated (or repeated) query param into a trimmed string array, or
 * undefined when absent - filterPayload treats undefined as "no filter", same as MCP's
 * omitted-argument default.
 * @param {*} value - req.query[name]
 * @returns {Array<string>|undefined}
 */
function parseListParam(value) {
  const raw = Array.isArray(value) ? value.join(',') : value;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/**
 * Parse a boolean-ish query param ("1" or "true"), or undefined when absent.
 * @param {*} value - req.query[name]
 * @returns {boolean|undefined}
 */
function parseCompactParam(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  return raw === '1' || raw === 'true';
}

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

/**
 * Vercel entry point. The body lives in handleScalpContext so the test suite can
 * inject the context builder; production always uses buildScalpContext.
 */
export default function handler(req, res) {
  return handleScalpContext(req, res);
}

/**
 * @param {Object} req
 * @param {Object} res
 * @param {Object} [deps]
 * @param {Function} [deps.build=buildScalpContext] - injectable, for tests
 * @param {Function} [deps.record=recordServedCalls] - injectable, for tests
 */
export async function handleScalpContext(req, res, { build = buildScalpContext, record = recordServedCalls } = {}) {
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

    // Confirmation chart (phase 8b): parsed after auth, before the build. Absent -> the
    // JSON response below is unchanged.
    let chartRequest = null;
    try {
      chartRequest = parseChartArg(req.query && req.query.chart);
    } catch (err) {
      if (!(err instanceof ChartRequestError)) throw err;
      console.log(`[ScalpContext] requestId=${requestId} status=400 durationMs=${Date.now() - startedAt} chart=${err.code}`);
      return res.status(400).json({ error: err.message, requestId });
    }
    let chartSeries;
    // Bias/model objects are opt-in: build() is unchanged unless include asks for them.
    const include = parseListParam(req.query && req.query.include);
    const buildOpts = {
      ...(wantsBias(include) ? { includeBias: true } : {}),
      ...(wantsModel(include) ? { includeModel: true } : {})
    };
    const optBuild = Object.keys(buildOpts).length > 0 ? buildOpts : null;
    const payload = chartRequest
      ? await build({ ...buildOpts, chart: { ...chartRequest, onSeries: (s) => { chartSeries = s; } } })
      : await (optBuild ? build(optBuild) : build());

    // Query-param filtering (phase 5): parsed after auth, auth code above is untouched.
    // No params -> filterPayload is a no-op and the response is today's full payload.
    const filtered = filterPayload(payload, {
      symbols: parseListParam(req.query && req.query.symbols),
      include,
      compact: parseCompactParam(req.query && req.query.compact)
    });

    const warningsCount = Array.isArray(filtered?.warnings) ? filtered.warnings.length : 0;
    const symbolsCount = Array.isArray(filtered?.symbols)
      ? filtered.symbols.length
      : (filtered?.symbols ? 1 : 0);

    if (filtered?.dataStatus === 'unavailable') {
      console.log(`[ScalpContext] requestId=${requestId} status=503 durationMs=${Date.now() - startedAt} symbols=${symbolsCount} warnings=${warningsCount}`);
      return res.status(503).json({
        error: 'Market data unavailable',
        requestId,
        warnings: filtered?.warnings
      });
    }

    if (chartRequest) {
      let chart;
      try {
        chart = await renderContextChart(payload, chartRequest, chartSeries);
      } catch (err) {
        if (!(err instanceof ChartRequestError)) throw err;
        console.log(`[ScalpContext] requestId=${requestId} status=503 durationMs=${Date.now() - startedAt} chart=${err.code}`);
        return res.status(503).json({ error: err.message, requestId });
      }
      console.log(`[ScalpContext] requestId=${requestId} status=200 durationMs=${Date.now() - startedAt} chart=${chartRequest.symbol}:${chartRequest.timeframe} chartBytes=${chart.bytes} chartMs=${chart.durationMs}`);
      res.setHeader('Content-Type', 'image/png');
      return res.status(200).send(chart.png);
    }

    // Served-call recording (T3): the unfiltered payload, so compact/include/symbols
    // filters never hide the plan. Capped and swallowed; the response below is unchanged.
    try { await record(payload); } catch { /* recording never affects the response */ }

    console.log(`[ScalpContext] requestId=${requestId} status=200 durationMs=${Date.now() - startedAt} symbols=${symbolsCount} warnings=${warningsCount}`);
    return res.status(200).json({
      ...filtered,
      requestId
    });
  } catch (error) {
    console.log(`[ScalpContext] requestId=${requestId} status=500 durationMs=${Date.now() - startedAt} symbols=0 warnings=0`);
    return res.status(500).json({ error: 'Internal error', requestId });
  }
}
