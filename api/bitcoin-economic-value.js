/**
 * Bitcoin Economic Value Endpoint
 * GET /api/bitcoin/economic-value
 *
 * Returns Bitcoin's market price alongside a derived Economic Value series
 * built from long-duration economic anchors, plus the premium/discount
 * relationship between them.
 *
 * Query parameters
 *   range   1y | 2y | 5y | all      (default: all)
 *   view    full | summary          (default: full)
 *                                    summary omits history, for the home-page
 *                                    quick-reference module
 *   refresh true                     bypass the server-side cache
 *
 * The response always reports source status. When a provider is down the
 * affected anchors come back null rather than estimated, and `sources`
 * explains why.
 */

import * as providers from '../services/bitcoinDataProviders.js';
import {
  calculateHistoricalEconomicValue,
  ANCHOR_LABELS
} from '../services/bitcoinEconomicValue.js';

const RANGES = {
  '1y': { days: 365, step: 1 },
  '2y': { days: 730, step: 1 },
  '5y': { days: 1825, step: 2 },
  all: { days: null, step: 7 }
};

/**
 * Trim to the requested window, then thin long ranges so the payload stays
 * small. The last row is always kept so the series ends on today's reading.
 *
 * Thinning drops whole daily observations rather than averaging them: each
 * point that survives keeps its own real price, Economic Value and premium,
 * so hover inspection never reports a blended figure that never existed.
 */
function selectRange(history, rangeKey) {
  const range = RANGES[rangeKey] || RANGES.all;
  const windowed = range.days ? history.slice(-range.days) : history;

  if (range.step <= 1 || windowed.length === 0) return windowed;

  const thinned = [];
  for (let i = 0; i < windowed.length; i += range.step) thinned.push(windowed[i]);

  const last = windowed[windowed.length - 1];
  if (thinned[thinned.length - 1] !== last) thinned.push(last);
  return thinned;
}

/** Ranges with no usable Economic Value are marked so the UI can disable them. */
function describeAvailableRanges(history) {
  return Object.keys(RANGES).map((key) => {
    const rows = selectRange(history, key);
    const withValue = rows.filter((row) => row.economicValue !== null).length;
    return { key, label: key.toUpperCase(), points: rows.length, withEconomicValue: withValue };
  });
}

export async function buildEconomicValuePayload(query = {}) {
  const rangeKey = RANGES[query.range] ? query.range : 'all';
  const view = query.view === 'summary' ? 'summary' : 'full';
  const forceRefresh = query.refresh === 'true';

  // Spot price and history are independent; a failure in either is survivable.
  const [series, spot] = await Promise.all([
    providers.getBitcoinEconomicSeries({ forceRefresh }),
    providers.getBitcoinSpotPrice()
  ]);

  const result = calculateHistoricalEconomicValue(series.rows, {
    spotPrice: spot?.price ?? null
  });

  const payload = {
    current: result.current,
    meta: {
      generatedAt: new Date().toISOString(),
      methodologyVersion: result.config.version,
      cached: series.cached === true,
      stale: series.stale === true,
      dataFetchedAt: series.fetchedAt,
      spot: {
        price: spot?.price ?? null,
        change24h: spot?.change24h ?? null,
        source: spot?.source ?? 'unavailable'
      },
      sources: series.sources,
      anchorStatus: result.anchorStatus,
      anchorLabels: ANCHOR_LABELS,
      historyRange: {
        first: result.history.length ? result.history[0].date : null,
        last: result.history.length ? result.history[result.history.length - 1].date : null,
        days: result.history.length
      }
    },
    methodology: result.config,
    distribution: result.distribution
  };

  if (view === 'full') {
    payload.range = rangeKey;
    payload.availableRanges = describeAvailableRanges(result.history);
    payload.history = selectRange(result.history, rangeKey);
  }

  return payload;
}

/**
 * Vercel's legacy `routes` rewrites do not always repopulate `req.query`, and
 * api/analyze-full.js already works around the same thing. Fall back to parsing
 * the raw URL so `range` and `view` survive on both Express and Vercel.
 */
function readQuery(req) {
  const query = { ...(req.query || {}) };
  if (req.url && req.url.includes('?')) {
    const parsed = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
    for (const [key, value] of parsed.entries()) {
      if (query[key] === undefined) query[key] = value;
    }
  }
  return query;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const payload = await buildEconomicValuePayload(readQuery(req));

    // These metrics change once a day. Let the CDN carry the load, and keep
    // serving the previous copy while a refresh happens in the background.
    res.setHeader(
      'Cache-Control',
      'public, s-maxage=1800, stale-while-revalidate=86400'
    );

    if (!payload.current) {
      // Reachable when every provider is down and no cache exists. This is a
      // real outage, not an empty result, so say so explicitly.
      return res.status(503).json({
        error: 'Bitcoin economic data unavailable',
        message: 'No economic data provider could be reached.',
        meta: payload.meta
      });
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error('[BitcoinEconomicValue] Error:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
